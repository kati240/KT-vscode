import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface CallerInfo {
  name: string;
  filePath: string;
  line: number;
  snippet?: string;
  callSiteSnippet: string;
  category: 'same_module' | 'other_prod' | 'test';
  callSiteCount: number;
  score?: number;
  isTest?: boolean;
  flowTag?: string; // e.g. "Hot Path", "Init", "Callback", "Error/Retry"
  roleHint?: string;
}

export interface CalleeInfo {
  name: string;
  filePath: string;
  line: number;
  calledFromLines: number[];
  nodeId?: string;
  roleHint?: string;
}

export interface HarvestedContext {
  /** 1-based line number where the user's selection begins */
  startLine: number;
  /** 1-based line number where the user's selection ends */
  endLine: number;
  /** Language identifier of the document */
  languageId: string;
  /** File path or URI of the document */
  filePath: string;
  /** Exact selected code prefixed with [L<lineNum>]: for every line */
  selectedCodeNumbered: string;
  
  /** Enclosing function or method metadata */
  enclosingFunctionName?: string;
  enclosingStartLine?: number;
  enclosingEndLine?: number;
  isPartialSelection: boolean;

  /** Callers: top 10 candidates for LLM, and complete un-truncated allCallers */
  candidateProductionCallers: CallerInfo[];
  allCallers: CallerInfo[];

  /** Callees partitioned into selected lines vs other parent function calls, and allCallees */
  selectedCallees: CalleeInfo[];
  otherParentCallees: CalleeInfo[];
  allCallees: CalleeInfo[];

  /** Background scope context for LLM */
  backgroundContext?: string;
  backgroundType: 'call-hierarchy' | 'enclosing-scope' | 'none';
}

// Built-in keywords & language noise to filter out
const NOISE_FILTER = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'await', 'async',
  'console', 'log', 'error', 'warn', 'info', 'debug', 'trace', 'print', 'println', 'printf',
  'require', 'import', 'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'Math', 'parseInt', 'parseFloat', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Promise',
  'JSON', 'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'map', 'filter', 'reduce',
  'forEach', 'find', 'includes', 'indexOf', 'join', 'split', 'replace', 'replaceAll', 'trim',
  'toLowerCase', 'toUpperCase', 'substring', 'substr', 'toString', 'valueOf', 'keys', 'values',
  'entries', 'assign', 'resolve', 'reject', 'then', 'finally', 'listen', 'emit', 'on',
  'send', 'write', 'read', 'close', 'open', 'format', 'assert', 'expect', 'test', 'describe',
  'it', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'super', 'this', 'new', 'typeof',
  'sizeof', 'yield', 'throw', 'case', 'default', 'break', 'continue'
]);

const TEST_PATH_REGEX = /(test|spec|mock|stub|bench|__tests__)/i;
const ARCH_ENTRY_REGEX = /^(main|init|run|handle|process|dispatch|on[A-Z]|execute|driver|controller|start|serve)/i;

/**
 * Fast helper to read the exact line of code at a call site from current doc or disk file.
 */
function readCallSiteSnippet(currentDoc: vscode.TextDocument, filePath: string, line: number, fallback: string): string {
  const isCurrent =
    currentDoc.isUntitled ||
    filePath.toLowerCase() === currentDoc.fileName.toLowerCase() ||
    filePath.toLowerCase() === currentDoc.uri.toString().toLowerCase();

  if (isCurrent) {
    const zeroLine = Math.max(0, Math.min(currentDoc.lineCount - 1, line - 1));
    return currentDoc.lineAt(zeroLine).text.trim();
  }

  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split(/\r?\n/);
      const zeroLine = Math.max(0, Math.min(lines.length - 1, line - 1));
      return (lines[zeroLine] || fallback).trim();
    }
  } catch {}

  return fallback.trim();
}

/**
 * Recursively searches DocumentSymbols to find the innermost function/method containing position.
 */
function findInnermostEnclosingSymbol(symbols: vscode.DocumentSymbol[], range: vscode.Range): vscode.DocumentSymbol | null {
  let bestMatch: vscode.DocumentSymbol | null = null;

  for (const sym of symbols) {
    if (sym.range.contains(range.start) || sym.range.intersection(range)) {
      const isFunctionLike =
        sym.kind === vscode.SymbolKind.Function ||
        sym.kind === vscode.SymbolKind.Method ||
        sym.kind === vscode.SymbolKind.Constructor;

      if (isFunctionLike) {
        bestMatch = sym;
      }

      if (sym.children && sym.children.length > 0) {
        const childMatch = findInnermostEnclosingSymbol(sym.children, range);
        if (childMatch) {
          bestMatch = childMatch;
        }
      }
    }
  }

  return bestMatch;
}

/**
 * Harvests active editor selection with asymmetric scope resolution,
 * partial selection detection, caller ranking funnel, and un-truncated caller/callee collection.
 */
export async function harvestContext(
  editor: vscode.TextEditor,
  savedSelection?: vscode.Selection
): Promise<HarvestedContext | null> {
  const document = editor.document;
  const docIdentifier = document.uri.scheme === 'untitled' ? document.uri.toString() : document.fileName;

  // Resolve selection
  let selection = editor.selection;
  if (selection.isEmpty && savedSelection && !savedSelection.isEmpty) {
    selection = savedSelection;
  }

  if (selection.isEmpty) {
    const cursorLine = selection.active ? selection.active.line : 0;
    let startL = Math.max(0, cursorLine - 10);
    let endL = Math.min(document.lineCount - 1, cursorLine + 10);

    if (document.lineCount < 20) {
      startL = 0;
      endL = document.lineCount - 1;
    }

    selection = new vscode.Selection(
      new vscode.Position(startL, 0),
      new vscode.Position(endL, document.lineAt(endL).text.length)
    );
  }

  const startLine = selection.start.line + 1;
  const endLine = selection.end.line + 1;

  // Build line-numbered selected code (Primary Subject)
  const selectedLinesList: string[] = [];
  for (let l = selection.start.line; l <= selection.end.line; l++) {
    const lineNum = l + 1;
    const text = document.lineAt(l).text;
    selectedLinesList.push(`[L${lineNum}]: ${text}`);
  }
  const selectedCodeNumbered = selectedLinesList.join('\n');

  // 1. Partial Selection Resolution (Asymmetric Scope Resolution)
  let enclosingFunctionName: string | undefined;
  let enclosingStartLine: number | undefined;
  let enclosingEndLine: number | undefined;
  let isPartialSelection = false;
  let hierarchyTargetPos = selection.start;
  let enclosingSymbol: vscode.DocumentSymbol | null = null;

  try {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      document.uri
    );

    if (symbols && symbols.length > 0) {
      enclosingSymbol = findInnermostEnclosingSymbol(symbols, selection);
      if (enclosingSymbol) {
        enclosingFunctionName = enclosingSymbol.name;
        enclosingStartLine = enclosingSymbol.range.start.line + 1;
        enclosingEndLine = enclosingSymbol.range.end.line + 1;
        hierarchyTargetPos = enclosingSymbol.selectionRange.start;

        if (startLine > enclosingStartLine || endLine < enclosingEndLine) {
          isPartialSelection = true;
        }
      }
    }
  } catch {}

  // Fallback function name discovery
  if (!enclosingFunctionName) {
    const fnMatch = selectedCodeNumbered.match(/(?:function|class|def|fn|func|public|private|protected)\s+([a-zA-Z0-9_$]+)/);
    if (fnMatch) {
      enclosingFunctionName = fnMatch[1];
    } else {
      enclosingFunctionName = `Block (L${startLine}-L${endLine})`;
    }
  }

  // 2. Call Hierarchy Retrieval & Outgoing Callee Partitioning
  const rawCallersMap = new Map<string, { call: vscode.CallHierarchyIncomingCall; count: number; firstLine: number }>();
  const selectedCallees: CalleeInfo[] = [];
  const otherParentCallees: CalleeInfo[] = [];
  let backgroundContext: string | undefined;
  let backgroundType: 'call-hierarchy' | 'enclosing-scope' | 'none' = 'none';

  try {
    const prepareItems = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
      'vscode.prepareCallHierarchy',
      document.uri,
      hierarchyTargetPos
    );

    if (prepareItems && prepareItems.length > 0) {
      const rootItem = prepareItems[0];
      const [incoming, outgoing] = await Promise.all([
        vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
          'vscode.executeCallHierarchyProvideIncomingCalls',
          rootItem
        ).catch(() => []),
        vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
          'vscode.executeCallHierarchyProvideOutgoingCalls',
          rootItem
        ).catch(() => [])
      ]);

      // Deduplicate incoming callers - collect all without truncation
      if (incoming && incoming.length > 0) {
        for (const call of incoming) {
          const name = call.from.name;
          if (NOISE_FILTER.has(name.toLowerCase())) continue;

          const callerUriStr = call.from.uri.scheme === 'untitled' ? call.from.uri.toString() : call.from.uri.fsPath;
          const key = `${callerUriStr}::${name}`;
          const callLine = (call.fromRanges[0]?.start.line ?? call.from.range.start.line) + 1;

          if (rawCallersMap.has(key)) {
            const existing = rawCallersMap.get(key)!;
            existing.count += (call.fromRanges?.length || 1);
          } else {
            rawCallersMap.set(key, {
              call,
              count: call.fromRanges?.length || 1,
              firstLine: callLine
            });
          }
        }
      }

      // Partition Outgoing Callees based on selection overlap
      if (outgoing && outgoing.length > 0) {
        for (const call of outgoing) {
          const name = call.to.name;
          if (NOISE_FILTER.has(name.toLowerCase())) continue;

          const calledLines = (call.fromRanges || []).map(r => r.start.line + 1);
          const isInsideSelection = calledLines.some(l => l >= startLine && l <= endLine);
          const calleePath = call.to.uri.scheme === 'untitled' ? call.to.uri.toString() : call.to.uri.fsPath;

          const calleeItem: CalleeInfo = {
            name,
            filePath: calleePath,
            line: call.to.range.start.line + 1,
            calledFromLines: calledLines.length > 0 ? calledLines : [startLine]
          };

          if (isInsideSelection) {
            selectedCallees.push(calleeItem);
          } else {
            otherParentCallees.push(calleeItem);
          }
        }
      }

      backgroundType = 'call-hierarchy';
    }
  } catch {}

  // 3. Fallback Callee Scanning if LSP outgoing calls returned nothing
  if (selectedCallees.length === 0) {
    const rawCode = document.getText(selection);
    const callRegex = /\b([a-zA-Z_]\w*)\s*\(/g;
    let match: RegExpExecArray | null;
    const seenCallees = new Set<string>();

    while ((match = callRegex.exec(rawCode)) !== null) {
      const fnName = match[1];
      if (!NOISE_FILTER.has(fnName.toLowerCase()) && !seenCallees.has(fnName) && fnName !== enclosingFunctionName) {
        seenCallees.add(fnName);
        const matchPos = document.positionAt(document.offsetAt(selection.start) + match.index);
        const callLine = matchPos.line + 1;

        selectedCallees.push({
          name: fnName,
          filePath: docIdentifier,
          line: callLine,
          calledFromLines: [callLine]
        });
      }
    }

    if (isPartialSelection && enclosingStartLine && enclosingEndLine) {
      try {
        const fullFnStart = new vscode.Position(enclosingStartLine - 1, 0);
        const fullFnEnd = new vscode.Position(enclosingEndLine - 1, document.lineAt(enclosingEndLine - 1).text.length);
        const fullFnCode = document.getText(new vscode.Range(fullFnStart, fullFnEnd));

        let m2: RegExpExecArray | null;
        while ((m2 = callRegex.exec(fullFnCode)) !== null) {
          const fnName = m2[1];
          if (!NOISE_FILTER.has(fnName.toLowerCase()) && !seenCallees.has(fnName) && fnName !== enclosingFunctionName) {
            seenCallees.add(fnName);
            const pos = document.positionAt(document.offsetAt(fullFnStart) + m2.index);
            const line = pos.line + 1;
            if (line < startLine || line > endLine) {
              otherParentCallees.push({
                name: fnName,
                filePath: docIdentifier,
                line,
                calledFromLines: [line]
              });
            }
          }
        }
      } catch {}
    }
  }

  // Fallback Caller Scanning if LSP incoming calls returned nothing
  if (rawCallersMap.size === 0 && enclosingFunctionName && !enclosingFunctionName.startsWith('Block (')) {
    try {
      const docText = document.getText();
      const escapedFnName = enclosingFunctionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const callerRegex = new RegExp(`\\b${escapedFnName}\\s*\\(`, 'g');
      let m: RegExpExecArray | null;

      while ((m = callerRegex.exec(docText)) !== null) {
        const callerPos = document.positionAt(m.index);
        const callerLine = callerPos.line + 1;
        if (callerLine < startLine || callerLine > endLine) {
          const snippet = document.lineAt(callerPos.line).text.trim();
          const key = `${docIdentifier}::line_${callerLine}`;
          rawCallersMap.set(key, {
            call: {
              from: {
                name: `Caller (L${callerLine})`,
                kind: vscode.SymbolKind.Function,
                uri: document.uri,
                range: new vscode.Range(callerPos, callerPos),
                selectionRange: new vscode.Range(callerPos, callerPos),
                detail: snippet
              },
              fromRanges: [new vscode.Range(callerPos, callerPos)]
            },
            count: 1,
            firstLine: callerLine
          });
        }
      }
    } catch {}
  }

  // 4. Complete Un-truncated Caller Collection with Precise Call-Site Snippets
  const currentDocDir = path.dirname(document.fileName).toLowerCase();
  const currentDocPath = document.fileName.toLowerCase();

  const allCallers: CallerInfo[] = [];

  for (const { call, count, firstLine } of rawCallersMap.values()) {
    const callerPath = call.from.uri.scheme === 'untitled' ? call.from.uri.toString() : call.from.uri.fsPath;
    const callerName = call.from.name;
    const isTest = TEST_PATH_REGEX.test(callerPath) || TEST_PATH_REGEX.test(callerName);

    const isSameFile = callerPath.toLowerCase() === currentDocPath || callerPath.toLowerCase() === document.uri.toString().toLowerCase();
    const isSameDir = !document.isUntitled && path.dirname(callerPath).toLowerCase() === currentDocDir;

    // Determine category
    let category: 'same_module' | 'other_prod' | 'test' = 'other_prod';
    if (isTest) {
      category = 'test';
    } else if (isSameFile || isSameDir) {
      category = 'same_module';
    }

    // Score calculation for production ranking
    let score = 0;
    if (isSameFile) score += 30;
    else if (isSameDir) score += 20;

    if (ARCH_ENTRY_REGEX.test(callerName)) score += 15;

    const lineSpan = call.from.range.end.line - call.from.range.start.line;
    if (lineSpan <= 3 && lineSpan >= 0) score -= 10;
    score += Math.min(10, (count - 1) * 2);

    // Read the exact line of code at the call site
    const callSiteSnippet = readCallSiteSnippet(document, callerPath, firstLine, call.from.detail || callerName);

    allCallers.push({
      name: callerName,
      filePath: callerPath,
      line: firstLine,
      snippet: callSiteSnippet,
      callSiteSnippet,
      category,
      callSiteCount: count,
      score,
      isTest
    });
  }

  // Sort allCallers: production callers by score descending, then tests
  allCallers.sort((a, b) => {
    if (a.isTest && !b.isTest) return 1;
    if (!a.isTest && b.isTest) return -1;
    return (b.score ?? 0) - (a.score ?? 0);
  });

  // Top 10 production callers sent to LLM for flowTag & roleHint assignment
  const prodCallers = allCallers.filter(c => !c.isTest);
  const candidateProductionCallers = prodCallers.slice(0, 10);
  const allCallees = [...selectedCallees, ...otherParentCallees];

  // 5. Enclosing Scope Fallback for context
  if (!backgroundContext) {
    const scopeLines: string[] = [];
    const beforeStart = Math.max(0, selection.start.line - 15);
    const beforeEnd = selection.start.line;

    if (beforeStart < beforeEnd) {
      scopeLines.push('--- [Preceding Context] ---');
      for (let l = beforeStart; l < beforeEnd; l++) {
        scopeLines.push(`[Context L${l + 1}]: ${document.lineAt(l).text}`);
      }
    }

    const afterStart = selection.end.line + 1;
    const afterEnd = Math.min(document.lineCount - 1, selection.end.line + 16);

    if (afterStart <= afterEnd && afterStart < document.lineCount) {
      scopeLines.push('--- [Succeeding Context] ---');
      for (let l = afterStart; l <= afterEnd; l++) {
        scopeLines.push(`[Context L${l + 1}]: ${document.lineAt(l).text}`);
      }
    }

    if (scopeLines.length > 0) {
      backgroundContext = scopeLines.join('\n');
      backgroundType = 'enclosing-scope';
    }
  }

  return {
    startLine,
    endLine,
    languageId: document.languageId,
    filePath: docIdentifier,
    selectedCodeNumbered,
    enclosingFunctionName,
    enclosingStartLine,
    enclosingEndLine,
    isPartialSelection,
    candidateProductionCallers,
    allCallers,
    selectedCallees,
    otherParentCallees,
    allCallees,
    backgroundContext,
    backgroundType
  };
}

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
 * Strips parameter signatures and class prefixes from LSP symbol names (e.g. "Operate(int, int)" -> "Operate").
 */
export function cleanSymbolName(rawName: string): string {
  if (!rawName) return '';
  return rawName
    .replace(/\(.*$/, '')
    .replace(/<.*$/, '')
    .replace(/^.*(?:::|\.|->)/, '')
    .trim();
}

/**
 * Recursively searches DocumentSymbols to find the innermost function/method containing line range.
 */
function findInnermostEnclosingSymbol(symbols: vscode.DocumentSymbol[], range: vscode.Range): vscode.DocumentSymbol | null {
  let bestMatch: vscode.DocumentSymbol | null = null;

  for (const sym of symbols) {
    const overlapsLine =
      sym.range.start.line <= range.end.line && sym.range.end.line >= range.start.line;
    if (overlapsLine || sym.range.contains(range.start) || sym.range.intersection(range)) {
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
 * Recursively searches DocumentSymbols for a function/method matching the given name.
 */
export function findFunctionSymbolByName(symbols: vscode.DocumentSymbol[], targetName: string): vscode.DocumentSymbol | null {
  const cleanedTarget = cleanSymbolName(targetName).toLowerCase();
  if (!cleanedTarget) return null;

  for (const sym of symbols) {
    const isFunctionLike =
      sym.kind === vscode.SymbolKind.Function ||
      sym.kind === vscode.SymbolKind.Method ||
      sym.kind === vscode.SymbolKind.Constructor;

    if (isFunctionLike && cleanSymbolName(sym.name).toLowerCase() === cleanedTarget) {
      return sym;
    }

    if (sym.children && sym.children.length > 0) {
      const child = findFunctionSymbolByName(sym.children, targetName);
      if (child) return child;
    }
  }

  return null;
}

/**
 * Resolves the actual definition file and 1-based line number of a called function.
 */
async function resolveCalleeDefinition(
  document: vscode.TextDocument,
  docIdentifier: string,
  docSymbols: vscode.DocumentSymbol[],
  fnName: string,
  callPos: vscode.Position,
  callLine: number
): Promise<{ filePath: string; line: number }> {
  // 1. Try LSP Definition Provider at the exact call site position
  try {
    const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      'vscode.executeDefinitionProvider',
      document.uri,
      callPos
    );
    if (defs && defs.length > 0) {
      const first = defs[0] as any;
      const targetUri: vscode.Uri | undefined = first.targetUri || first.uri;
      const targetRange: vscode.Range | undefined = first.targetSelectionRange || first.targetRange || first.range;
      if (targetUri && targetRange) {
        const defPath = targetUri.scheme === 'untitled' ? targetUri.toString() : targetUri.fsPath;
        const defLine = targetRange.start.line + 1;
        if (defPath !== docIdentifier || defLine !== callLine) {
          return { filePath: defPath, line: defLine };
        }
      }
    }
  } catch {}

  // 2. Search DocumentSymbols in current file by function name
  if (docSymbols.length > 0) {
    const matchedSym = findFunctionSymbolByName(docSymbols, fnName);
    if (matchedSym) {
      return {
        filePath: docIdentifier,
        line: matchedSym.selectionRange.start.line + 1
      };
    }
  }

  // 3. Search current document text for function/method definition of fnName
  try {
    const escaped = fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declPatterns = [
      new RegExp(`^\\s*(?:(?:public|private|protected|internal|static|async|virtual|override|export|default|function|def|fn|func)\\s+)+[a-zA-Z0-9_<>\\[\\]?,\\s]*\\b${escaped}\\s*\\(`, 'm'),
      new RegExp(`^\\s*(?:[a-zA-Z0-9_<>\\[\\]?]+\\s+)+${escaped}\\s*\\([^;]*\\)\\s*(?:\\{|=>|:)`, 'm'),
      new RegExp(`^\\s*(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>)`, 'm'),
      new RegExp(`^\\s*(?:async\\s+)?${escaped}\\s*\\([^;]*\\)\\s*\\{`, 'm')
    ];

    for (let i = 0; i < document.lineCount; i++) {
      if (i + 1 === callLine) continue;
      const lineText = document.lineAt(i).text;
      // Combine with next line in case opening brace is on the next line (C# / Allman style)
      const twoLineText = i + 1 < document.lineCount ? `${lineText}\n${document.lineAt(i + 1).text}` : lineText;
      if (declPatterns.some(p => p.test(twoLineText))) {
        return { filePath: docIdentifier, line: i + 1 };
      }
    }
  } catch {}

  // 4. Try Workspace Symbol Provider across workspace files
  try {
    const wsSymbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      'vscode.executeWorkspaceSymbolProvider',
      fnName
    );
    if (wsSymbols && wsSymbols.length > 0) {
      const fnSym = wsSymbols.find(s =>
        (s.kind === vscode.SymbolKind.Function || s.kind === vscode.SymbolKind.Method) &&
        cleanSymbolName(s.name).toLowerCase() === fnName.toLowerCase()
      );
      if (fnSym && fnSym.location) {
        const uri = fnSym.location.uri;
        return {
          filePath: uri.scheme === 'untitled' ? uri.toString() : uri.fsPath,
          line: fnSym.location.range.start.line + 1
        };
      }
    }
  } catch {}

  return { filePath: docIdentifier, line: callLine };
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
  let docSymbols: vscode.DocumentSymbol[] = [];

  try {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      document.uri
    );

    if (symbols && symbols.length > 0) {
      docSymbols = symbols;
      enclosingSymbol = findInnermostEnclosingSymbol(symbols, selection);
      if (enclosingSymbol) {
        enclosingFunctionName = cleanSymbolName(enclosingSymbol.name) || enclosingSymbol.name;
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
    const fnMatch = selectedCodeNumbered.match(/(?:function|class|def|fn|func|public|private|protected|internal|static|async|void|int|string|bool)\s+(?:[a-zA-Z0-9_<>[\]?]+\s+)*([a-zA-Z0-9_$]+)\s*\(/);
    if (fnMatch && !NOISE_FILTER.has(fnMatch[1].toLowerCase())) {
      enclosingFunctionName = fnMatch[1];
    } else {
      enclosingFunctionName = `Block (L${startLine}-L${endLine})`;
    }
  }

  const cleanEnclosing = cleanSymbolName(enclosingFunctionName);
  const rawSelectedCode = document.getText(selection);

  // 2. Call Hierarchy Retrieval & Outgoing Callee Partitioning
  const rawCallersMap = new Map<string, { call: vscode.CallHierarchyIncomingCall; count: number; firstLine: number }>();
  const selectedCallees: CalleeInfo[] = [];
  const otherParentCallees: CalleeInfo[] = [];
  const seenCalleeNames = new Set<string>();
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
          const name = cleanSymbolName(call.from.name) || call.from.name;
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
          const name = cleanSymbolName(call.to.name) || call.to.name;
          if (NOISE_FILTER.has(name.toLowerCase())) continue;

          let calledLines = (call.fromRanges || []).map(r => r.start.line + 1);
          let isInsideSelection = calledLines.some(l => l >= startLine && l <= endLine);

          // If LSP fromRanges was empty or pointed to enclosing declaration, verify against selected lines directly
          if (!isInsideSelection && name) {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const invokeRe = new RegExp(`\\b${escaped}\\s*\\(`);
            for (let l = selection.start.line; l <= selection.end.line; l++) {
              const lineNum = l + 1;
              if (lineNum === enclosingStartLine && name.toLowerCase() === cleanEnclosing.toLowerCase()) continue;
              if (invokeRe.test(document.lineAt(l).text)) {
                isInsideSelection = true;
                if (!calledLines.includes(lineNum)) {
                  calledLines.push(lineNum);
                }
              }
            }
          }

          const calleePath = call.to.uri.scheme === 'untitled' ? call.to.uri.toString() : call.to.uri.fsPath;
          const defLine = (call.to.selectionRange?.start.line ?? call.to.range.start.line) + 1;

          const calleeItem: CalleeInfo = {
            name,
            filePath: calleePath,
            line: defLine,
            calledFromLines: calledLines.length > 0 ? calledLines : [startLine]
          };

          seenCalleeNames.add(name.toLowerCase());
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

  // 3. Fallback / Supplemental Callee Scanning + Definition Resolution
  {
    const callRegex = /\b([a-zA-Z_]\w*)\s*\(/g;
    let match: RegExpExecArray | null;

    while ((match = callRegex.exec(rawSelectedCode)) !== null) {
      const fnName = match[1];
      const lowerFn = fnName.toLowerCase();
      if (NOISE_FILTER.has(lowerFn) || seenCalleeNames.has(lowerFn)) continue;

      const matchPos = document.positionAt(document.offsetAt(selection.start) + match.index);
      const callLine = matchPos.line + 1;

      // Skip if this match is the enclosing function's own declaration header
      const lineText = document.lineAt(matchPos.line).text;
      const isOwnDeclaration =
        fnName.toLowerCase() === cleanEnclosing.toLowerCase() &&
        (callLine === enclosingStartLine || /(?:function|def|fn|func|public|private|protected|internal|static|void|int|string|bool)\s+/.test(lineText));
      if (isOwnDeclaration) continue;

      seenCalleeNames.add(lowerFn);
      const resolvedDef = await resolveCalleeDefinition(
        document,
        docIdentifier,
        docSymbols,
        fnName,
        matchPos,
        callLine
      );

      selectedCallees.push({
        name: fnName,
        filePath: resolvedDef.filePath,
        line: resolvedDef.line,
        calledFromLines: [callLine]
      });
    }

    if (isPartialSelection && enclosingStartLine && enclosingEndLine) {
      try {
        const fullFnStart = new vscode.Position(enclosingStartLine - 1, 0);
        const fullFnEnd = new vscode.Position(enclosingEndLine - 1, document.lineAt(enclosingEndLine - 1).text.length);
        const fullFnCode = document.getText(new vscode.Range(fullFnStart, fullFnEnd));

        let m2: RegExpExecArray | null;
        while ((m2 = callRegex.exec(fullFnCode)) !== null) {
          const fnName = m2[1];
          const lowerFn = fnName.toLowerCase();
          if (NOISE_FILTER.has(lowerFn) || seenCalleeNames.has(lowerFn) || lowerFn === cleanEnclosing.toLowerCase()) continue;

          const pos = document.positionAt(document.offsetAt(fullFnStart) + m2.index);
          const line = pos.line + 1;
          if (line < startLine || line > endLine) {
            seenCalleeNames.add(lowerFn);
            const resolvedDef = await resolveCalleeDefinition(
              document,
              docIdentifier,
              docSymbols,
              fnName,
              pos,
              line
            );
            otherParentCallees.push({
              name: fnName,
              filePath: resolvedDef.filePath,
              line: resolvedDef.line,
              calledFromLines: [line]
            });
          }
        }
      } catch {}
    }
  }

  // Fallback Caller Scanning if LSP incoming calls returned nothing
  if (rawCallersMap.size === 0 && cleanEnclosing && !cleanEnclosing.startsWith('Block (')) {
    try {
      const docText = document.getText();
      const escapedFnName = cleanEnclosing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const callerRegex = new RegExp(`\\b${escapedFnName}\\s*\\(`, 'g');
      let m: RegExpExecArray | null;

      const bodyStart = enclosingStartLine || startLine;
      const bodyEnd = enclosingEndLine || endLine;

      while ((m = callerRegex.exec(docText)) !== null) {
        const callerPos = document.positionAt(m.index);
        const callerLine = callerPos.line + 1;
        if (callerLine < bodyStart || callerLine > bodyEnd) {
          const snippet = document.lineAt(callerPos.line).text.trim();
          const callerSym = docSymbols.length > 0
            ? findInnermostEnclosingSymbol(docSymbols, new vscode.Range(callerPos, callerPos))
            : null;
          const callerFnName = callerSym ? (cleanSymbolName(callerSym.name) || callerSym.name) : `Caller (L${callerLine})`;
          const key = `${docIdentifier}::${callerFnName}_${callerLine}`;
          rawCallersMap.set(key, {
            call: {
              from: {
                name: callerFnName,
                kind: vscode.SymbolKind.Function,
                uri: document.uri,
                range: callerSym ? callerSym.range : new vscode.Range(callerPos, callerPos),
                selectionRange: callerSym ? callerSym.selectionRange : new vscode.Range(callerPos, callerPos),
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

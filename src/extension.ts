import * as vscode from 'vscode';
import { harvestContext, cleanSymbolName, findFunctionSymbolByName } from './contextHarvester';
import { analyzeSelectionWithLLM } from './llmClient';
import { CodeMistSidebarProvider } from './sidebarProvider';
import { resolveDocumentAndUri } from './uriUtils';

/**
 * Resolves the exact full-body range of a target function by symbol tree or brace/indent matching.
 */
async function resolveExploredFunctionRange(
  doc: vscode.TextDocument,
  uri: vscode.Uri,
  line: number,
  name: string
): Promise<vscode.Range> {
  const zeroLine = Math.max(0, Math.min(doc.lineCount - 1, (line || 1) - 1));
  const cleanTarget = cleanSymbolName(name).toLowerCase();
  const isGenericCallerLabel = /^caller\s*\(/i.test(name) || /^block\s*\(/i.test(name);

  // 1. Try DocumentSymbolProvider first
  try {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      uri
    );
    if (symbols && symbols.length > 0) {
      // Collect all function/method/constructor symbols
      const fnSymbols: vscode.DocumentSymbol[] = [];
      const collectFnSymbols = (list: vscode.DocumentSymbol[]) => {
        for (const s of list) {
          if (
            s.kind === vscode.SymbolKind.Function ||
            s.kind === vscode.SymbolKind.Method ||
            s.kind === vscode.SymbolKind.Constructor
          ) {
            fnSymbols.push(s);
          }
          if (s.children && s.children.length > 0) {
            collectFnSymbols(s.children);
          }
        }
      };
      collectFnSymbols(symbols);

      // Priority A: Function symbol matching name AND containing/starting near zeroLine
      if (cleanTarget && !isGenericCallerLabel) {
        const nameMatches = fnSymbols.filter(
          s => cleanSymbolName(s.name).toLowerCase() === cleanTarget
        );
        if (nameMatches.length > 0) {
          nameMatches.sort((a, b) =>
            Math.abs(a.range.start.line - zeroLine) - Math.abs(b.range.start.line - zeroLine)
          );
          return nameMatches[0].range;
        }
      }

      // Priority B: Innermost function symbol whose line range contains zeroLine
      const containing = fnSymbols.filter(
        s => s.range.start.line <= zeroLine && s.range.end.line >= zeroLine
      );
      if (containing.length > 0) {
        containing.sort((a, b) =>
          (a.range.end.line - a.range.start.line) - (b.range.end.line - b.range.start.line)
        );
        return containing[0].range;
      }

      // Priority C: Any symbol matching name via tree helper
      if (cleanTarget && !isGenericCallerLabel) {
        const byName = findFunctionSymbolByName(symbols, name);
        if (byName) return byName.range;
      }
    }
  } catch {}

  // 2. Fallback: Text-based Function Header + Brace/Indentation Body Extraction
  let declLine = -1;

  // 2a. If we have a real function name, find its definition line in the document
  if (cleanTarget && !isGenericCallerLabel) {
    const escaped = cleanTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declRe = new RegExp(
      `^\\s*(?:(?:public|private|protected|internal|static|async|virtual|override|export|default|function|def|fn|func|[a-zA-Z0-9_<>\\[\\]?]+)\\s+)*${escaped}\\s*\\(`,
      'i'
    );

    // Check near zeroLine first
    for (let offset = 0; offset <= 3; offset++) {
      for (const candidate of [zeroLine - offset, zeroLine + offset]) {
        if (candidate >= 0 && candidate < doc.lineCount) {
          const text = doc.lineAt(candidate).text;
          const nextText = candidate + 1 < doc.lineCount ? doc.lineAt(candidate + 1).text : '';
          if (declRe.test(text) && (text.includes('{') || text.trim().endsWith(':') || text.includes('=>') || nextText.trim().startsWith('{'))) {
            declLine = candidate;
            break;
          }
        }
      }
      if (declLine !== -1) break;
    }

    // Scan whole file if zeroLine was actually the call site rather than the definition
    if (declLine === -1) {
      for (let i = 0; i < doc.lineCount; i++) {
        const text = doc.lineAt(i).text;
        const nextText = i + 1 < doc.lineCount ? doc.lineAt(i + 1).text : '';
        if (declRe.test(text) && (text.includes('{') || text.trim().endsWith(':') || text.includes('=>') || nextText.trim().startsWith('{'))) {
          declLine = i;
          break;
        }
      }
    }
  }

  // 2b. If still not found (e.g. exploring an upstream caller from a call site), scan upwards for enclosing function header
  if (declLine === -1) {
    const genericHeaderRe = /^\s*(?:(?:public|private|protected|internal|static|async|virtual|override|export|default|function|def|fn|func)\s+)+[a-zA-Z0-9_<>[\]?\s]*\b([a-zA-Z_]\w*)\s*\(/;
    for (let i = zeroLine; i >= Math.max(0, zeroLine - 60); i--) {
      const text = doc.lineAt(i).text;
      if (genericHeaderRe.test(text)) {
        declLine = i;
        break;
      }
    }
  }

  if (declLine === -1) {
    declLine = zeroLine;
  }

  // 2c. Extract full body from declLine via brace counting or Python indentation
  const firstLineText = doc.lineAt(declLine).text;
  if (/^\s*(?:async\s+)?def\s+/.test(firstLineText) && firstLineText.trim().endsWith(':')) {
    const baseIndent = firstLineText.search(/\S|$/);
    let endL = declLine;
    for (let i = declLine + 1; i < Math.min(doc.lineCount, declLine + 120); i++) {
      const t = doc.lineAt(i).text;
      if (t.trim().length === 0 || t.trim().startsWith('#')) continue;
      const indent = t.search(/\S|$/);
      if (indent <= baseIndent) break;
      endL = i;
    }
    return new vscode.Range(declLine, 0, endL, doc.lineAt(endL).text.length);
  }

  // Brace matching for C-family / JS / TS / C# / Java / Go / Rust
  let braceDepth = 0;
  let foundOpenBrace = false;
  let endL = Math.min(doc.lineCount - 1, declLine + 30);

  for (let i = declLine; i < Math.min(doc.lineCount, declLine + 150); i++) {
    const lineStr = doc.lineAt(i).text;
    for (let c = 0; c < lineStr.length; c++) {
      const ch = lineStr[c];
      if (ch === '{') {
        braceDepth++;
        foundOpenBrace = true;
      } else if (ch === '}') {
        braceDepth--;
      }
    }
    if (foundOpenBrace && braceDepth <= 0) {
      endL = i;
      break;
    }
  }

  return new vscode.Range(declLine, 0, endL, doc.lineAt(endL).text.length);
}

function isCodeEditor(editor?: vscode.TextEditor): editor is vscode.TextEditor {
  if (!editor) return false;
  const scheme = editor.document.uri.scheme;
  return scheme !== 'output' && scheme !== 'debug' && scheme !== 'vscode-terminal';
}

export function activate(context: vscode.ExtensionContext) {
  // Track last active editor and selection so clicking in the sidebar or right-clicking never loses selection
  const initialEditors = vscode.window.visibleTextEditors.filter(isCodeEditor);
  let lastActiveEditor: vscode.TextEditor | undefined =
    (isCodeEditor(vscode.window.activeTextEditor) ? vscode.window.activeTextEditor : undefined) ||
    initialEditors.find(e => !e.selection.isEmpty) ||
    initialEditors[0];

  let lastSelection: vscode.Selection | undefined =
    lastActiveEditor && !lastActiveEditor.selection.isEmpty ? lastActiveEditor.selection : undefined;
  let lastSelectionTime = lastSelection ? Date.now() : 0;

  // Register CodeMist Sidebar Provider
  const sidebarProvider = new CodeMistSidebarProvider(context.extensionUri);

  // Wire up drill-down Explore Function handler
  sidebarProvider.onExploreFunctionHandler = async (filePath: string, line: number, name: string) => {
    try {
      sidebarProvider.showLoading();

      const { uri, doc } = await resolveDocumentAndUri(filePath);
      const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false });

      const targetRange = await resolveExploredFunctionRange(doc, uri, line, name);

      editor.selection = new vscode.Selection(targetRange.start, targetRange.end);
      editor.revealRange(targetRange, vscode.TextEditorRevealType.InCenter);

      const harvested = await harvestContext(editor, editor.selection);
      if (!harvested) {
        sidebarProvider.showError('Could not harvest context for explored function.');
        return;
      }

      const cleanedName = cleanSymbolName(name);
      if (cleanedName && !/^caller\s*\(/i.test(name)) {
        harvested.enclosingFunctionName = cleanedName;
        harvested.isPartialSelection = false;
      }

      const analysis = await analyzeSelectionWithLLM(harvested);
      sidebarProvider.renderAnalysis(analysis, doc.uri, true);
    } catch (err: any) {
      const msg = err?.message || String(err);
      sidebarProvider.showError(`Failed to explore ${name}: ${msg}`);
      vscode.window.showErrorMessage(`CodeMist Explore Error: ${msg}`);
    }
  };

  // Wire up Expand to Full Function handler
  sidebarProvider.onExpandToFullFunctionHandler = async (startLine: number, endLine: number) => {
    try {
      const visibleCodeEditors = vscode.window.visibleTextEditors.filter(isCodeEditor);
      let editor =
        (isCodeEditor(vscode.window.activeTextEditor) ? vscode.window.activeTextEditor : undefined) ||
        lastActiveEditor ||
        visibleCodeEditors[0];
      if (!editor) return;

      const doc = editor.document;
      const startL = Math.max(0, startLine - 1);
      const endL = Math.min(doc.lineCount - 1, endLine - 1);
      const range = new vscode.Range(startL, 0, endL, doc.lineAt(endL).text.length);

      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

      await vscode.commands.executeCommand('codemist.explainSelection');
    } catch (err: any) {
      vscode.window.showErrorMessage(`CodeMist Expand Error: ${err?.message || err}`);
    }
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (isCodeEditor(editor)) {
        lastActiveEditor = editor;
        if (!editor.selection.isEmpty) {
          lastSelection = editor.selection;
          lastSelectionTime = Date.now();
        }
      }
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (isCodeEditor(event.textEditor)) {
        lastActiveEditor = event.textEditor;
        if (!event.selections[0]?.isEmpty) {
          lastSelection = event.selections[0];
          lastSelectionTime = Date.now();
        }

        // Reverse Cursor Sync: notify Webview of cursor line in active file
        const currentLine = event.selections[0].active.line + 1;
        sidebarProvider.sendCursorMoved(currentLine, event.textEditor.document.uri.toString());
      }
    })
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CodeMistSidebarProvider.viewType,
      sidebarProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    )
  );

  // Register Explain Selection Command (Ctrl+Shift+U / Alt+U / Context Menu)
  const explainCommand = vscode.commands.registerCommand(
    'codemist.explainSelection',
    async () => {
      const visibleCodeEditors = vscode.window.visibleTextEditors.filter(isCodeEditor);
      let editor =
        visibleCodeEditors.find(e => !e.selection.isEmpty) ||
        (isCodeEditor(vscode.window.activeTextEditor) ? vscode.window.activeTextEditor : undefined) ||
        lastActiveEditor ||
        visibleCodeEditors[0];

      if (!editor) {
        vscode.window.showWarningMessage('CodeMist: Please open a file in the editor to explain.');
        return;
      }

      let relevantSelection: vscode.Selection | undefined;
      if (!editor.selection.isEmpty) {
        relevantSelection = editor.selection;
      } else if (
        lastSelection &&
        !lastSelection.isEmpty &&
        lastActiveEditor?.document.uri.toString() === editor.document.uri.toString() &&
        (Date.now() - lastSelectionTime < 15000 ||
          (editor.selection.active.line >= lastSelection.start.line - 2 &&
           editor.selection.active.line <= lastSelection.end.line + 2))
      ) {
        relevantSelection = lastSelection;
      } else {
        // Cursor is in the editor without a selection: automatically resolve the enclosing function range
        const cursorLine = (editor.selection.active?.line ?? 0) + 1;
        const autoRange = await resolveExploredFunctionRange(
          editor.document,
          editor.document.uri,
          cursorLine,
          ''
        );
        relevantSelection = new vscode.Selection(autoRange.start, autoRange.end);
      }

      const harvested = await harvestContext(editor, relevantSelection);
      if (!harvested) {
        return;
      }

      try {
        await vscode.commands.executeCommand('codemist.sidebarView.focus');
      } catch {}

      sidebarProvider.showLoading();

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `CodeMist: Tracing ${harvested.enclosingFunctionName || 'Selection'} (L${harvested.startLine}-L${harvested.endLine})...`,
          cancellable: false
        },
        async (progress) => {
          try {
            progress.report({ message: 'Synthesizing visual flow, callers, and edge cases...' });
            const analysis = await analyzeSelectionWithLLM(harvested);

            progress.report({ message: 'Rendering interactive trace...' });
            sidebarProvider.renderAnalysis(analysis, editor.document.uri, false);
          } catch (err: any) {
            const errorMsg = err?.message || String(err);
            sidebarProvider.showError(errorMsg);
            vscode.window.showErrorMessage(`CodeMist Error: ${errorMsg}`);
          }
        }
      );
    }
  );

  context.subscriptions.push(explainCommand);
}

export function deactivate() {}

import * as vscode from 'vscode';
import { harvestContext } from './contextHarvester';
import { analyzeSelectionWithLLM } from './llmClient';
import { CodeMistSidebarProvider } from './sidebarProvider';
import { resolveDocumentAndUri } from './uriUtils';

export function activate(context: vscode.ExtensionContext) {
  // Track last active editor and selection so clicking in the sidebar never loses selection
  let lastActiveEditor = vscode.window.activeTextEditor;
  let lastSelection: vscode.Selection | undefined = lastActiveEditor?.selection;

  // Register CodeMist Sidebar Provider
  const sidebarProvider = new CodeMistSidebarProvider(context.extensionUri);

  // Wire up drill-down Explore Function handler
  sidebarProvider.onExploreFunctionHandler = async (filePath: string, line: number, name: string) => {
    try {
      sidebarProvider.showLoading();

      const { uri, doc } = await resolveDocumentAndUri(filePath);
      const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false });

      // Try finding the symbol range via DocumentSymbolProvider
      let targetRange: vscode.Range | undefined;
      try {
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          'vscode.executeDocumentSymbolProvider',
          uri
        );
        if (symbols && symbols.length > 0) {
          const targetPos = new vscode.Position(Math.max(0, line - 1), 0);
          const findSymbol = (syms: vscode.DocumentSymbol[]): vscode.DocumentSymbol | null => {
            for (const s of syms) {
              if (s.range.contains(targetPos)) {
                if (s.children && s.children.length > 0) {
                  const child = findSymbol(s.children);
                  if (child) return child;
                }
                return s;
              }
            }
            return null;
          };
          const matched = findSymbol(symbols);
          if (matched) {
            targetRange = matched.range;
          }
        }
      } catch {}

      if (!targetRange) {
        const startL = Math.max(0, line - 1);
        const endL = Math.min(doc.lineCount - 1, startL + 25);
        targetRange = new vscode.Range(startL, 0, endL, doc.lineAt(endL).text.length);
      }

      editor.selection = new vscode.Selection(targetRange.start, targetRange.end);
      editor.revealRange(targetRange, vscode.TextEditorRevealType.InCenter);

      const harvested = await harvestContext(editor, editor.selection);
      if (!harvested) {
        sidebarProvider.showError('Could not harvest context for explored function.');
        return;
      }

      if (name && !harvested.enclosingFunctionName) {
        harvested.enclosingFunctionName = name;
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
      let editor = vscode.window.activeTextEditor || lastActiveEditor || vscode.window.visibleTextEditors[0];
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
      if (editor) {
        lastActiveEditor = editor;
        if (!editor.selection.isEmpty) {
          lastSelection = editor.selection;
        }
      }
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor) {
        lastActiveEditor = event.textEditor;
        if (!event.selections[0]?.isEmpty) {
          lastSelection = event.selections[0];
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
      let editor = vscode.window.activeTextEditor || lastActiveEditor || vscode.window.visibleTextEditors[0];
      if (!editor) {
        vscode.window.showWarningMessage('CodeMist: Please open a file in the editor to explain.');
        return;
      }

      let relevantSelection: vscode.Selection | undefined;
      if (lastSelection && lastActiveEditor?.document.uri.toString() === editor.document.uri.toString()) {
        relevantSelection = lastSelection;
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

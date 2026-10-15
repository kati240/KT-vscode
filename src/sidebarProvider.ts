import * as vscode from 'vscode';
import * as fs from 'fs';
import { AnalysisResult } from './llmClient';
import { resolveDocumentAndUri } from './uriUtils';

export interface BreadcrumbItem {
  name: string;
  filePath: string;
  data: AnalysisResult;
}

export class CodeMistSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codemist.sidebarView';

  private _view?: vscode.WebviewView;
  private _cachedAnalysis?: AnalysisResult;
  private _cachedTargetDocumentUri?: vscode.Uri;

  // Callbacks for extension host actions
  public onExploreFunctionHandler?: (filePath: string, line: number, name: string) => Promise<void>;
  public onExpandToFullFunctionHandler?: (startLine: number, endLine: number) => Promise<void>;

  // Text editor decoration type for highlighting jumped-to lines
  private _highlightDecorationType: vscode.TextEditorDecorationType;

  constructor(private readonly _extensionUri: vscode.Uri) {
    this._highlightDecorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('editor.selectionHighlightBackground'),
      border: '1px solid rgba(255, 171, 0, 0.7)',
      borderRadius: '3px',
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.warningForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Full
    });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'media')
      ]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages sent from Webview to Host
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'highlightLines': {
          await this._handleHighlightLines(message.startLine, message.endLine);
          break;
        }
        case 'jumpToFileLine': {
          await this._handleJumpToFileLine(message.filePath, message.line);
          break;
        }
        case 'exploreFunction': {
          if (this.onExploreFunctionHandler) {
            await this.onExploreFunctionHandler(message.filePath, message.line, message.name);
          }
          break;
        }
        case 'expandToFullFunction': {
          if (this.onExpandToFullFunctionHandler) {
            await this.onExpandToFullFunctionHandler(message.startLine, message.endLine);
          }
          break;
        }
        case 'copyToClipboard': {
          if (message.text) {
            await vscode.env.clipboard.writeText(message.text);
            vscode.window.setStatusBarMessage('CodeMist: Copied Markdown for PR/Docs to clipboard!', 3000);
          }
          break;
        }
        case 'requestAnalysis': {
          await vscode.commands.executeCommand('codemist.explainSelection');
          break;
        }
        case 'webviewReady': {
          if (this._cachedAnalysis) {
            const pathOrUri = this._cachedTargetDocumentUri?.scheme === 'untitled'
              ? this._cachedTargetDocumentUri.toString()
              : (this._cachedTargetDocumentUri?.fsPath || '');
            this._view?.webview.postMessage({
              command: 'renderAnalysis',
              data: this._cachedAnalysis,
              filePath: pathOrUri
            });
          }
          break;
        }
      }
    });
  }

  /**
   * Highlights and reveals the specified 1-based line range in the active editor.
   */
  private async _handleHighlightLines(startLine: number, endLine: number) {
    let editor = vscode.window.activeTextEditor;

    if (!editor || (this._cachedTargetDocumentUri && editor.document.uri.toString() !== this._cachedTargetDocumentUri.toString())) {
      if (this._cachedTargetDocumentUri) {
        try {
          const { doc } = await resolveDocumentAndUri(this._cachedTargetDocumentUri.toString());
          editor = await vscode.window.showTextDocument(doc, { preserveFocus: false });
        } catch {
          // Fall back to current editor
        }
      }
    }

    if (!editor) return;

    const doc = editor.document;
    const clampedStart = Math.max(0, Math.min(doc.lineCount - 1, startLine - 1));
    const clampedEnd = Math.max(0, Math.min(doc.lineCount - 1, endLine - 1));

    const startPos = new vscode.Position(clampedStart, 0);
    const endPos = new vscode.Position(clampedEnd, doc.lineAt(clampedEnd).text.length);
    const range = new vscode.Range(startPos, endPos);

    editor.selection = new vscode.Selection(startPos, endPos);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    editor.setDecorations(this._highlightDecorationType, [{ range }]);

    setTimeout(() => {
      if (editor) {
        editor.setDecorations(this._highlightDecorationType, []);
      }
    }, 3500);
  }

  /**
   * Opens arbitrary file (or untitled buffer) and jumps to the specified line.
   */
  private async _handleJumpToFileLine(filePath: string, line: number) {
    try {
      const { doc } = await resolveDocumentAndUri(filePath);
      const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false });

      const targetLine = Math.max(0, Math.min(doc.lineCount - 1, line - 1));
      const pos = new vscode.Position(targetLine, 0);
      const lineText = doc.lineAt(targetLine).text;
      const endPos = new vscode.Position(targetLine, lineText.length);
      const range = new vscode.Range(pos, endPos);

      editor.selection = new vscode.Selection(pos, endPos);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      editor.setDecorations(this._highlightDecorationType, [{ range }]);

      setTimeout(() => {
        if (editor) {
          editor.setDecorations(this._highlightDecorationType, []);
        }
      }, 3500);
    } catch (err: any) {
      vscode.window.showErrorMessage(`CodeMist: Could not open ${filePath}: ${err?.message || err}`);
    }
  }

  /**
   * Reverse cursor sync: notifies webview of current editor line.
   */
  public sendCursorMoved(line: number, fileUri: string) {
    if (!this._view || !this._cachedTargetDocumentUri) return;

    if (this._cachedTargetDocumentUri.toString() === fileUri) {
      this._view.webview.postMessage({
        command: 'cursorMoved',
        line
      });
    }
  }

  public showLoading() {
    this._view?.show?.(true);
    this._view?.webview.postMessage({ command: 'showLoading' });
  }

  public showError(message: string) {
    this._view?.show?.(true);
    this._view?.webview.postMessage({ command: 'showError', message });
  }

  public renderAnalysis(data: AnalysisResult, targetDocumentUri?: vscode.Uri, isDrillDown: boolean = false) {
    this._cachedAnalysis = data;
    this._cachedTargetDocumentUri = targetDocumentUri;
    this._view?.show?.(true);

    const pathOrUri = targetDocumentUri?.scheme === 'untitled'
      ? targetDocumentUri.toString()
      : (targetDocumentUri?.fsPath || '');

    this._view?.webview.postMessage({
      command: isDrillDown ? 'pushAnalysis' : 'renderAnalysis',
      data,
      filePath: pathOrUri
    });
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'media', 'sidebar.html').fsPath;
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');

    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'sidebar.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'sidebar.js'));
    const mermaidUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'vendor', 'mermaid.min.js'));

    htmlContent = htmlContent
      .replace(/\{\{cspSource\}\}/g, webview.cspSource)
      .replace(/\{\{styleUri\}\}/g, styleUri.toString())
      .replace(/\{\{scriptUri\}\}/g, scriptUri.toString())
      .replace(/\{\{mermaidUri\}\}/g, mermaidUri.toString());

    return htmlContent;
  }
}

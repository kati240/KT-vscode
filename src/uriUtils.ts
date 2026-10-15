import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Safely resolves any file path or URI string into a valid vscode.TextDocument and vscode.Uri.
 * Gracefully handles untitled files (e.g. 'Untitled-1', 'untitled:Untitled-1', '\Untitled-1'),
 * unsaved buffers, and disk files.
 */
export async function resolveDocumentAndUri(filePathOrUri: string): Promise<{ uri: vscode.Uri; doc: vscode.TextDocument }> {
  if (!filePathOrUri) {
    const active = vscode.window.activeTextEditor?.document;
    if (active) return { uri: active.uri, doc: active };
    throw new Error('No target document provided and no active editor found');
  }

  const clean = filePathOrUri.trim();
  const lower = clean.toLowerCase();
  const base = path.basename(clean).toLowerCase();

  // 1. Search among already open text documents (handles untitled buffers and open files)
  const openDoc = vscode.workspace.textDocuments.find(d => {
    const dUriStr = d.uri.toString().toLowerCase();
    const dFileName = d.fileName.toLowerCase();
    const dBase = path.basename(d.fileName).toLowerCase();
    if (dUriStr === lower || dFileName === lower || dBase === base) {
      return true;
    }
    if (d.isUntitled) {
      const cleanLower = clean.replace(/^[\\/]+/, '').replace(/^untitled:/, '').toLowerCase();
      const dCleanLower = d.fileName.replace(/^[\\/]+/, '').replace(/^untitled:/, '').toLowerCase();
      if (cleanLower === dCleanLower || dUriStr.includes(cleanLower) || cleanLower.includes(dCleanLower)) {
        return true;
      }
    }
    return false;
  });

  if (openDoc) {
    return { uri: openDoc.uri, doc: openDoc };
  }

  // 2. Parse URI according to scheme
  let uri: vscode.Uri;
  if (clean.startsWith('untitled:') || clean.includes('://')) {
    uri = vscode.Uri.parse(clean);
  } else if (/^[\\/]?untitled/i.test(clean)) {
    const name = clean.replace(/^[\\/]+/, '');
    uri = vscode.Uri.parse(`untitled:${name}`);
  } else {
    uri = vscode.Uri.file(clean);
  }

  const doc = await vscode.workspace.openTextDocument(uri);
  return { uri, doc };
}

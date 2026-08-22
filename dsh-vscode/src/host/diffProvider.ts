import { execFile } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import type { WorkspaceChange } from "./workspaceChanges";

export const HEAD_SCHEME = "dsh-head";

/**
 * Serves `git show HEAD:<relPath>` for the diff editor's "left" side. For a new
 * (untracked) file the command fails and we serve an empty string, so the diff
 * shows the whole file as an addition.
 */
export class DshHeadProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string | Thenable<string> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const relPath = uri.query ? decodeURIComponent(uri.query) : "";
    if (!root || !relPath) return "";
    return new Promise((resolve) => {
      execFile("git", ["show", `HEAD:${relPath}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        resolve(err ? "" : stdout);
      });
    });
  }
}

function headUri(relPath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: HEAD_SCHEME, path: relPath, query: encodeURIComponent(relPath) });
}

export function openChangeDiff(root: string, change: WorkspaceChange): void {
  if (change.kind === "deleted") {
    void vscode.workspace.openTextDocument(headUri(change.relPath)).then((doc) => {
      void vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
    });
    return;
  }
  const left = headUri(change.relPath); // empty for untracked files (git show fails)
  const right = vscode.Uri.file(path.join(root, change.relPath));
  void vscode.commands.executeCommand("vscode.diff", left, right, `${change.relPath} — 运行改动`, {
    preview: true,
  });
}
import * as path from "node:path";
import * as vscode from "vscode";
import { openChangeDiff } from "./diffProvider";
import { gitChangedHunks } from "./gitHunks";
import type { WorkspaceChange } from "./workspaceChanges";

/**
 * Editor-native "装饰" for workspace changes detected after a headless run:
 *  - CodeLens ("DSH 运行改动 · 查看 diff") on every changed file, lazily shown
 *    when the file opens;
 *  - on currently-visible changed files, a decoration carrying a minimap ruler
 *    mark, a highlight, ghost text ("↳ DSH 改") and a hover — the file-modify
 *    presentation without a gutter icon asset.
 */
export class DshChangeCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;
  private marks = new Map<string, { root: string; change: WorkspaceChange }>();

  mark(root: string, changes: WorkspaceChange[]): void {
    this.marks.clear();
    for (const c of changes) this.marks.set(path.join(root, c.relPath), { root, change: c });
    this._onDidChange.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const mark = this.marks.get(document.uri.fsPath);
    if (!mark || mark.change.kind === "deleted") return [];
    return [
      new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        title: "DSH 运行改动 · 查看 diff",
        command: "dsh.openChangeDiff",
        arguments: [mark.root, mark.change],
      }),
    ];
  }
}

let decoration: vscode.TextEditorDecorationType | undefined;

export async function applyChangeDecorations(root: string, changes: WorkspaceChange[]): Promise<void> {
  const byRel = new Map(changes.map((c) => [c.relPath, c] as const));
  if (!decoration) {
    decoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(86, 156, 214, 0.12)",
      overviewRulerColor: "rgba(86, 156, 214, 0.65)",
      after: { contentText: " ↳ DSH 改", color: "rgba(156, 157, 157, 0.7)", fontStyle: "italic" },
    });
  }

  for (const editor of vscode.window.visibleTextEditors) {
    const relPath = path.relative(root, editor.document.uri.fsPath);
    const change = byRel.get(relPath);
    if (!change || change.kind === "deleted") continue;
    const ranges = await rangesFor(root, change, editor.document.lineCount);
    editor.setDecorations(decoration, ranges);
  }
}

async function rangesFor(root: string, change: WorkspaceChange, lineCount: number): Promise<vscode.DecorationOptions[]> {
  if (change.kind === "added") return lineSpans(0, lineCount);

  const h = await gitChangedHunks(root, change.relPath);
  if (h.isNew) return lineSpans(0, lineCount);
  if (h.hunks.length === 0) return lineSpans(0, 1); // binary / no hunks: mark top line

  return h.hunks.flatMap((hunk) => lineSpans(hunk.start - 1, hunk.count));
}

function lineSpans(start0: number, count: number): vscode.DecorationOptions[] {
  const out: vscode.DecorationOptions[] = [];
  const n = Math.min(count, 500);
  for (let i = 0; i < n; i++) {
    const line = start0 + i;
    out.push({
      range: new vscode.Range(line, 0, line, 0),
      hoverMessage: new vscode.MarkdownString("**DSH 运行期间改动**（`dsh --profile headless`）"),
    });
  }
  return out;
}
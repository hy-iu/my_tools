import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Pure workspace-change detection: scan timestamp/size stamps before and after
 * a headless run, then diff the two scans. This is the P1 "文件修改" signal and
 * deliberately does NOT read DSH session data (S2 ruling).
 */

export interface FileStamp {
  mtimeMs: number;
  size: number;
}

export type ChangeKind = "added" | "modified" | "deleted";

export interface WorkspaceChange {
  relPath: string;
  kind: ChangeKind;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "out",
  "build",
  "coverage",
  ".npm-cache",
  ".cache",
  "target",
]);

const MAX_FILES = 5000;
const MAX_DEPTH = 8;

export function scanTree(root: string): Map<string, FileStamp> {
  const map = new Map<string, FileStamp>();
  if (!root) return map;
  const stat = safeStat(root);
  if (stat && stat.isDirectory()) walk(root, root, 0, map);
  return map;
}

function walk(rootAbs: string, dirAbs: string, depth: number, map: Map<string, FileStamp>): void {
  if (depth > MAX_DEPTH || map.size >= MAX_FILES) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (map.size >= MAX_FILES) return;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(rootAbs, path.join(dirAbs, entry.name), depth + 1, map);
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const abs = path.join(dirAbs, entry.name);
    const st = safeStat(abs);
    if (!st) continue;
    map.set(path.relative(rootAbs, abs), { mtimeMs: st.mtimeMs, size: st.size });
  }
}

function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/**
 * Compare two scans. `modified` keys off mtimeMs, so a content write that keeps
 * the same mtime resolution (rare) could be missed; size is kept for future
 * content-hash fallback but not used for the equality decision here.
 */
export function diffScan(before: Map<string, FileStamp>, after: Map<string, FileStamp>): WorkspaceChange[] {
  const out: WorkspaceChange[] = [];
  for (const [relPath, stamp] of after) {
    const prev = before.get(relPath);
    if (!prev) {
      out.push({ relPath, kind: "added" });
      continue;
    }
    if (prev.mtimeMs !== stamp.mtimeMs) out.push({ relPath, kind: "modified" });
  }
  for (const relPath of before.keys()) {
    if (!after.has(relPath)) out.push({ relPath, kind: "deleted" });
  }
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}
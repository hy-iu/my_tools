import { execFile } from "node:child_process";

/**
 * Line-level change ranges for one file, via `git diff --unified=0 HEAD -- <path>`.
 * Pure (no VSCode import) so it tests against a throwaway git repo in plain Node.
 * Ranges are 1-based NEW-file line spans (the `+c,d` side of each hunk header),
 * which is what an editor decoration on the current file needs.
 */

export interface LineRange {
  start: number; // 1-based first changed line in the NEW file
  count: number; // number of lines in the changed region
}

export interface FileHunks {
  isNew: boolean; // untracked (new file): the whole file is an addition
  binary: boolean;
  hunks: LineRange[];
}

export function gitChangedHunks(root: string, relPath: string): Promise<FileHunks> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["diff", "--unified=0", "--no-color", "HEAD", "--", relPath],
      { cwd: root, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          // git unavailable / non-repo / unreadable path — cannot determine.
          resolve({ isNew: false, binary: false, hunks: [] });
          return;
        }
        if (stdout.trim().length > 0) {
          resolve({ isNew: false, binary: /^Binary files/i.test(stdout.trim()), hunks: parseHunks(stdout) });
          return;
        }
        // Empty diff: either untracked (new file) or tracked-but-unchanged.
        execFile("git", ["ls-files", "--error-unmatch", "--", relPath], { cwd: root }, (lsErr) => {
          resolve({ isNew: !!lsErr, binary: false, hunks: [] });
        });
      },
    );
  });
}

function parseHunks(diff: string): LineRange[] {
  const out: LineRange[] = [];
  for (const line of diff.split("\n")) {
    if (!line.startsWith("@@")) continue;
    const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!m) continue;
    out.push({ start: Number(m[1]), count: m[2] === undefined ? 1 : Number(m[2]) });
  }
  return out;
}
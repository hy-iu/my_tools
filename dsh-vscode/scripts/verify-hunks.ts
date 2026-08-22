import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitChangedHunks } from "../src/host/gitHunks";

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "dsh-hunks-"));
  const run = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  run(["init", "-q"]);
  run(["config", "user.email", "t@t"]);
  run(["config", "user.name", "t"]);

  writeFileSync(join(root, "a.txt"), "line1\nline2\nline3\n");
  run(["add", "a.txt"]);
  run(["commit", "-qm", "init"]);

  // Insert two lines and modify the tail → one hunk starting at new line 2.
  writeFileSync(join(root, "a.txt"), "line1\nNEW1\nNEW2\nline2\nline3-changed\n");
  writeFileSync(join(root, "b.txt"), "x\ny\n"); // untracked → isNew

  const a = await gitChangedHunks(root, "a.txt");
  const b = await gitChangedHunks(root, "b.txt");
  console.log("a.txt:", JSON.stringify(a));
  console.log("b.txt:", "isNew =", b.isNew, "binary =", b.binary);

  const added = a.hunks.reduce((s, h) => s + h.count, 0);
  const ok =
    a.hunks.length >= 1 &&
    a.hunks[0].start === 2 &&
    added >= 3 &&
    b.isNew === true &&
    b.hunks.length === 0;

  console.log(ok ? "\nPASS ✓ (hunk parse + untracked detection)" : "\nFAIL ✗");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
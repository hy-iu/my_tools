import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { diffScan, scanTree } from "../src/host/workspaceChanges";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-changes-"));
const nested = path.join(root, "src");
const skip = path.join(root, "node_modules");
fs.mkdirSync(nested, { recursive: true });
fs.mkdirSync(skip, { recursive: true });
fs.writeFileSync(path.join(root, "a.txt"), "aaa");
fs.writeFileSync(path.join(nested, "b.ts"), "bbb");
fs.writeFileSync(path.join(skip, "dep.js"), "should be skipped");

const before = scanTree(root);
console.log("before scan:", [...before.keys()].sort());

// modify a.txt, add c.md, delete src/b.ts
fs.writeFileSync(path.join(root, "a.txt"), "aaa-changed");
fs.writeFileSync(path.join(root, "c.md"), "ccc");
fs.rmSync(path.join(nested, "b.ts"));

const after = scanTree(root);
const changes = diffScan(before, after);
console.log("after scan :", [...after.keys()].sort());
console.log("changes    :", changes.map((c) => `${c.kind} ${c.relPath}`));

// Clean up.
fs.rmSync(root, { recursive: true, force: true });

const ok =
  changes.length === 3 &&
  changes.some((c) => c.kind === "modified" && c.relPath === "a.txt") &&
  changes.some((c) => c.kind === "added" && c.relPath === "c.md") &&
  changes.some((c) => c.kind === "deleted" && c.relPath === path.join("src", "b.ts")) &&
  !before.has(path.join("node_modules", "dep.js"));

console.log(ok ? "\nPASS ✓ (node_modules skipped; add/modify/delete detected)" : "\nFAIL ✗");
process.exit(ok ? 0 : 1);
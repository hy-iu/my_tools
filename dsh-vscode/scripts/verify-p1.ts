import { resolveDshHome } from "../src/host/dshHome";
import { locateDsh, resolveDshInstallDir, smokeTest } from "../src/host/dshLocator";
import { readModelDirectory, readPresets, readSkills } from "../src/host/diskReader";

const home = resolveDshHome();
const bin = locateDsh();
const installDir = bin ? resolveDshInstallDir(bin) : undefined;

console.log("dshHome      :", home);
console.log("dshBin       :", bin);
console.log("installDir   :", installDir);
console.log("smokeTest    :", bin ? smokeTest(bin) : "n/a");

const md = readModelDirectory(home);
console.log(`\nmodelProviders: ${md.providers.length}`);
for (const p of md.providers) {
  console.log(`  ${p.id}${p.name ? ` (${p.name})` : ""} → ${p.models.length} models`);
  console.log(`    ${p.models.slice(0, 6).map((m) => m.id).join(", ")}${p.models.length > 6 ? " …" : ""}`);
}
console.log("default       :", md.defaultProvider, "/", md.defaultModel);

const presets = readPresets(home, installDir);
console.log(`\npresets       : ${presets.length}`);
for (const pr of presets) {
  const desc = pr.description ? ` — ${pr.description.slice(0, 60)}` : "";
  console.log(`  [${pr.trust}] ${pr.id}${pr.name ? " · " + pr.name : ""}${pr.broken ? " ⚠ " + pr.broken : ""}${desc}`);
}

const skills = readSkills(home);
console.log(`\nskills        : ${skills.length}`, skills.map((s) => s.id));
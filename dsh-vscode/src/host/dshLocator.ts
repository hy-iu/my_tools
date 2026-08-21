import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Locate the `dsh` executable. Pure (no `vscode` import): the optional
 * `configExecutable` is the `dsh.executablePath` setting, injected by the
 * extension host, so this module stays testable from plain Node.
 *
 * Order: config value, `DSH_BIN` env, known install prefixes, then a PATH walk
 * via `which`. Returns null so callers can show an actionable error.
 */
export function locateDsh(configExecutable?: string): string | null {
  if (configExecutable) {
    try {
      if (fs.existsSync(configExecutable)) return fs.realpathSync(configExecutable);
    } catch {
      // Broken symlink / vanished path — fall through.
    }
  }

  const env = process.env.DSH_BIN;
  if (env && fs.existsSync(env)) return env;

  const candidates = [
    "/opt/homebrew/bin/dsh", // macOS Apple Silicon (Homebrew)
    "/usr/local/bin/dsh", // macOS Intel (Homebrew) / common Linux prefix
    "/usr/bin/dsh",
    path.join(os.homedir(), ".local", "bin", "dsh"),
    path.join(os.homedir(), ".dsh", "bin", "dsh"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  try {
    const found = execFileSync("which", ["dsh"], { encoding: "utf8" }).trim();
    if (found) return found;
  } catch {
    // `which` unavailable or nothing found.
  }
  return null;
}

/** Smoke-test that a resolved path is actually runnable. */
export function smokeTest(dsh: string): boolean {
  try {
    execFileSync(dsh, ["--version"], { encoding: "utf8", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * From a `dsh` binary path, recover the DSH install directory that holds
 * `config/agent-presets` (the shipped presets). The standard layout is
 * `<install>/lib/bin.js`, so two `dirname` hops land on the install directory.
 */
export function resolveDshInstallDir(dshBin: string): string | undefined {
  try {
    const real = fs.realpathSync(dshBin);
    const libDir = path.dirname(real); // <install>/lib
    if (fs.existsSync(path.join(libDir, "bin.js"))) {
      return path.dirname(libDir); // <install>
    }
    return path.dirname(real); // fallback: a `dsh` launcher sitting directly in a bin dir
  } catch {
    return undefined;
  }
}
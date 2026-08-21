import * as os from "node:os";
import * as path from "node:path";

/**
 * Resolve the DSH data home (`~/.dsh` by default).
 *
 * Precedence matches DSH itself: an explicit config value (`dsh.home`), the
 * `DSH_HOME` environment variable, then `~/.dsh`. Never hardcode `~/.dsh` as
 * the only answer.
 */
export function resolveDshHome(configValue?: string): string {
  const candidates = [configValue, process.env.DSH_HOME];
  for (const raw of candidates) {
    if (raw && raw.trim()) return expandHome(raw.trim());
  }
  return path.join(os.homedir(), ".dsh");
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}
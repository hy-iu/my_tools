import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

export function backupFile(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${filePath}.bak-cockpit-${stamp}`;
  copyFileSync(filePath, backup);
  try {
    chmodSync(backup, 0o600);
  } catch {
    // best effort on platforms without chmod
  }
  return backup;
}

export function readJsonSafe(filePath: string): any | undefined {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

export function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

/** Replace `key = "value"` lines that live at the TOML top level (before any [section]). */
export function replaceTopLevelToml(content: string, key: string, value: string): string {
  const lines = content.split('\n');
  let inSection = false;
  let replaced = false;
  const re = new RegExp(`^${key}\\s*=`);
  const out = lines.map((line) => {
    if (/^\s*\[/.test(line)) inSection = true;
    if (!inSection && re.test(line) && !replaced) {
      replaced = true;
      return `${key} = ${JSON.stringify(value)}`;
    }
    return line;
  });
  if (!replaced) out.unshift(`${key} = ${JSON.stringify(value)}`);
  return out.join('\n');
}

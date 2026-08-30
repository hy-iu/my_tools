// Platform discovery: which agent-config roots can this cockpit process see?
//   local          — the OS home of this process
//   wsl:<Distro>   — a WSL distro's home, read through \\wsl.localhost (win32)
//   root:<id>      — manual extra roots from ~/.cockpit/platforms.json
//                    (e.g. a mounted MacBook home or an sshfs Ubuntu mount)
// Every ingester/capability scanner runs once per platform, so the same
// agent on the host and inside WSL lands as separate, labelled sessions.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import path from 'node:path';

export interface Platform {
  id: string; // stable id used in session ids: 'local' | 'wsl:Ubuntu-26.04' | 'root:macbook'
  kind: 'local' | 'wsl' | 'root';
  label: string; // human display, e.g. 'WSL · Ubuntu-26.04'
  home: string; // home dir path readable by THIS process
  slug: string; // fs/url-safe, used to prefix session ids (must match /^[\w.-]+$/)
  available: boolean;
}

export const LOCAL_PLATFORM_ID = 'local';

function slugify(s: string): string {
  return s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

function run(cmd: string, args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1e6 }, (err, stdout) => {
      resolve(err ? '' : String(stdout ?? ''));
    });
  });
}

async function wslDistros(): Promise<string[]> {
  if (osPlatform() !== 'win32') return [];
  // wsl.exe prints UTF-16LE on stdout; strip NUL padding either way.
  const raw = await run('wsl.exe', ['--list', '--quiet']);
  return raw
    .replace(/\0/g, '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !/^(docker-desktop.*|wsl.*)$/i.test(s));
}

async function wslHome(distro: string): Promise<string | undefined> {
  // Resolve the default user's $HOME inside the distro.
  const out = await run('wsl.exe', ['-d', distro, '-e', 'sh', '-c', 'echo "$HOME"']);
  const home = out.replace(/\0/g, '').trim();
  if (!home || !home.startsWith('/')) return undefined;
  return `\\\\wsl.localhost\\${distro}\\` + home.replace(/^\//, '').replace(/\//g, '\\');
}

function manualRoots(): Platform[] {
  // ~/.cockpit/platforms.json: [{ "id": "macbook", "home": "/Volumes/mac/Users/me" }, ...]
  const file = path.join(homedir(), '.cockpit', 'platforms.json');
  try {
    const list = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(list)) return [];
    return list
      .filter((r: any) => r && typeof r.id === 'string' && typeof r.home === 'string')
      .map((r: any) => ({
        id: `root:${r.id}`,
        kind: 'root' as const,
        label: r.label ?? r.id,
        home: r.home,
        slug: slugify(`root-${r.id}`),
        available: existsSync(r.home),
      }));
  } catch {
    return [];
  }
}

export async function discoverPlatforms(): Promise<Platform[]> {
  const platforms: Platform[] = [
    { id: LOCAL_PLATFORM_ID, kind: 'local', label: 'local host', home: homedir(), slug: 'local', available: true },
  ];
  for (const distro of await wslDistros()) {
    const home = await wslHome(distro);
    platforms.push({
      id: `wsl:${distro}`,
      kind: 'wsl',
      label: `WSL · ${distro}`,
      home: home ?? `\\\\wsl.localhost\\${distro}`,
      slug: slugify(`wsl-${distro}`),
      available: !!home,
    });
  }
  platforms.push(...manualRoots());
  return platforms;
}

/** Prefix for session ids ingested from a non-local platform. Local keeps
 *  bare ids (backward compatible with existing rows). */
export function scopedSessionId(platform: Platform, id: string): string {
  if (platform.id === LOCAL_PLATFORM_ID) return id;
  return `${platform.slug}__${id}`;
}

/** Same scoping, from a raw platform id (used by shared.writeSession). */
export function scopedSessionIdById(platformId: string | undefined, id: string): string {
  if (!platformId || platformId === LOCAL_PLATFORM_ID) return id;
  if (platformId.startsWith('root:')) return `${slugify(`root-${platformId.slice(5)}`)}__${id}`;
  if (platformId.startsWith('wsl:')) return `${slugify(`wsl-${platformId.slice(4)}`)}__${id}`;
  return `${slugify(platformId)}__${id}`;
}

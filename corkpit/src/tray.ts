// Cockpit tray orchestrator (Windows).
// Owns the tray host process (tray/tray.ps1 via powershell.exe), ensures the
// cockpit server is up, feeds it /api/health status, and maps tray menu events
// to actions. IPC with the host is FILE-based (~/.cockpit/tray): piped stdin
// into a GUI host gets killed by some security tooling (verified empirically).
// Update checks only notify — they never install anything (per the dsh-web
// background-service discussion: remind, don't act).
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { writeFileSync, renameSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRAY_PS1 = path.join(ROOT, 'tray', 'tray.ps1');
const IPC_DIR = process.env.COCKPIT_TRAY_IPC || path.join(homedir(), '.cockpit', 'tray');
const CMD_FILE = path.join(IPC_DIR, 'cmd.json');
const EVENT_FILE = path.join(IPC_DIR, 'event.json');
const STATUS_INTERVAL_MS = 30_000;
const EVENT_POLL_MS = 500;
const DSH_WEB_URL = 'http://127.0.0.1:3080';

// keep the tray alive across transient errors; record them for diagnosis.
const ERR_LOG = path.join(IPC_DIR, 'errors.log');
function logErr(where: string, e: unknown): void {
  try {
    writeFileSync(ERR_LOG, `${new Date().toISOString()} ${where}: ${String(e)}
`, { flag: 'a' });
  } catch {
    /* ignore */
  }
}

interface Health {
  ok: boolean;
  active: number;
  todayCost: number;
  todayTokens: number;
  agents: { agent_id: string; active: number; sessions: number; last_activity: string | null }[];
}

// short "2m"/"3h"/"5d" ago for tray menu labels
function agoShort(ts: string | null | undefined): string {
  if (!ts) return '—';
  let iso = String(ts).includes('T') ? String(ts) : String(ts).replace(' ', 'T');
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(iso)) iso += 'Z';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

function httpJson<T>(method: string, url: string, timeoutMs = 5000): Promise<T | undefined> {
  return new Promise((resolve) => {
    const req = httpRequest(url, { method, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data) as T);
        } catch {
          resolve(undefined);
        }
      });
    });
    req.on('error', () => resolve(undefined));
    req.on('timeout', () => req.destroy());
    req.end();
  });
}

function run(cmd: string, args: string[], timeoutMs = 20_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4e6 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

function openInBrowser(url: string): void {
  if (process.platform === 'win32') {
    spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

// atomic write: stage then rename over
function sendCmd(obj: unknown): void {
  try {
    const tmp = CMD_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    renameSync(tmp, CMD_FILE);
  } catch (e) {
    logErr('sendCmd', e);
  }
}

export async function runTray(port: number): Promise<void> {
  if (process.platform !== 'win32') {
    console.error('cockpit tray currently supports Windows only (NotifyIcon host). Use `cockpit serve` instead.');
    process.exit(1);
  }

  const panelUrl = `http://127.0.0.1:${port}`;
  let serverChild: ChildProcess | undefined;

  // Reuse an already-running server; otherwise start our own.
  const pre = await httpJson<Health>('GET', `${panelUrl}/api/health`, 1500);
  if (!pre?.ok) {
    serverChild = spawn(process.execPath, [path.join(ROOT, 'dist', 'cli.js'), 'serve', '--port', String(port)], {
      cwd: ROOT,
      stdio: 'ignore',
      windowsHide: true,
    });
    // wait for it to come up (max ~6s)
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const h = await httpJson<Health>('GET', `${panelUrl}/api/health`, 1200);
      if (h?.ok) break;
    }
  }

  mkdirSync(IPC_DIR, { recursive: true });
  for (const f of [CMD_FILE, EVENT_FILE]) {
    try {
      unlinkSync(f);
    } catch {
      /* not there */
    }
  }

  const ps = spawn('powershell.exe', ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-File', TRAY_PS1], {
    stdio: ['ignore', 'ignore', 'inherit'],
    windowsHide: true,
    env: { ...process.env, COCKPIT_TRAY_IPC: IPC_DIR },
  });

  const balloon = (title: string, text: string, warn = false) => sendCmd({ cmd: 'balloon', title, text, warn });

  const pushStatus = async () => {
    console.error('[tray-debug] pushStatus: health...');
    let h = await httpJson<Health>('GET', `${panelUrl}/api/health`, 3000);
    console.error('[tray-debug] health=', h ? ('ok=' + h.ok) : 'undefined');
    for (let i = 0; i < 3 && !h?.ok; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      h = await httpJson<Health>('GET', `${panelUrl}/api/health`, 3000);
      console.error('[tray-debug] retry', i, h ? ('ok=' + h.ok) : 'undefined');
    }
    if (h?.ok) {
      console.error('[tray-debug] sending status with', (h.agents ?? []).length, 'agents');
      sendCmd({
        cmd: 'status',
        active: h.active,
        todayCost: '$' + Number(h.todayCost).toFixed(2),
        agents: (h.agents ?? []).slice(0, 8).map((a) => ({
          id: a.agent_id,
          active: a.active,
          sessions: a.sessions,
          last: agoShort(a.last_activity),
        })),
      });
    } else {
      sendCmd({ cmd: 'status', active: 0, todayCost: 'server down', agents: [] });
    }
  };

  // dsh update check — notify only, never install.
  const checkDshUpdate = async () => {
    const local = await run('cmd.exe', ['/d', '/s', '/c', 'npm ls -g @deepseek-ai/dsh --depth=0 --json'], 25_000);
    let current = '';
    try {
      const tree = JSON.parse(local.stdout);
      current = tree?.dependencies?.['@deepseek-ai/dsh']?.version ?? '';
    } catch {
      /* not installed or unparseable */
    }
    if (!current) {
      balloon('Cockpit · dsh update', 'dsh is not installed globally via npm — nothing to check.');
      return;
    }
    const remote = await run('cmd.exe', ['/d', '/s', '/c', 'npm view @deepseek-ai/dsh version'], 25_000);
    const latest = remote.stdout.trim();
    if (!remote.ok || !latest) {
      balloon('Cockpit · dsh update', 'could not reach the npm registry.', true);
      return;
    }
    if (latest === current) {
      balloon('Cockpit · dsh update', `dsh ${current} is up to date.`);
    } else {
      balloon('Cockpit · dsh update', `dsh ${latest} available (you have ${current}). Run \`npm i -g @deepseek-ai/dsh\` yourself when ready.`, true);
    }
  };

  const openDshWeb = async () => {
    const probe = await httpJson<unknown>('GET', DSH_WEB_URL, 1500);
    if (probe === undefined) {
      balloon('Cockpit · dsh web', `nothing answering at ${DSH_WEB_URL} — start it with \`dsh web --no-open\`.`, true);
      return;
    }
    openInBrowser(DSH_WEB_URL);
  };

  const handleEvent = (ev: { event?: string; agent?: string }) => {
    switch (ev.event) {
      case 'open-panel':
        openInBrowser(panelUrl);
        break;
      case 'open-agent':
        if (ev.agent) openInBrowser(`${panelUrl}/#mission?agent=${encodeURIComponent(ev.agent)}`);
        else openInBrowser(panelUrl);
        break;
      case 'ingest':
        void httpJson<{ sessions?: number; files?: number; byAgent?: Record<string, { sessions: number }> }>('POST', `${panelUrl}/api/ingest`).then((r) => {
          if (r) {
            const detail = Object.entries(r.byAgent ?? {})
              .filter(([, s]) => s.sessions > 0)
              .map(([a, s]) => `${a}:${s.sessions}`)
              .join(' ');
            balloon('Cockpit · ingest', `ingested ${r.sessions ?? 0} sessions from ${r.files ?? 0} files${detail ? ' (' + detail + ')' : ''}`);
            void pushStatus();
          } else {
            balloon('Cockpit · ingest', 'ingest failed — is the server running?', true);
          }
        });
        break;
      case 'check-update':
        void checkDshUpdate();
        break;
      case 'open-dsh-web':
        void openDshWeb();
        break;
      case 'exit':
        shutdown();
        break;
    }
  };

  let shuttingDown = false;
  let quitSent = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    quitSent = true;
    sendCmd({ cmd: 'quit' });
    const deadline = Date.now() + 2500;
    const waitExit = () => {
      if (ps.exitCode !== null || Date.now() > deadline) {
        try {
          ps.kill();
        } catch {
          /* ignore */
        }
        serverChild?.kill();
        process.exit(0);
      } else {
        setTimeout(waitExit, 200);
      }
    };
    waitExit();
  };

  // poll the event file written by the tray host
  setInterval(() => {
    if (!existsSync(EVENT_FILE)) return;
    let raw = '';
    try {
      raw = readFileSync(EVENT_FILE, 'utf8');
      unlinkSync(EVENT_FILE);
    } catch {
      return;
    }
    try {
      handleEvent(JSON.parse(raw));
    } catch {
      /* corrupt event file */
    }
  }, EVENT_POLL_MS);

  ps.on('exit', () => {
    if (!shuttingDown && !quitSent) console.log('tray host exited unexpectedly');
    serverChild?.kill();
    process.exit(0);
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // never let a transient error tear the tray down: log and keep running.
  process.on('uncaughtException', (e) => logErr('uncaughtException', e));
  process.on('unhandledRejection', (e) => logErr('unhandledRejection', e));

  void pushStatus();
  // auto update check on start — per the dsh-web discussion: check every
  // boot, remind with a toast/balloon, never install silently.
  setTimeout(() => void checkDshUpdate(), 4000);
  setInterval(() => void pushStatus(), STATUS_INTERVAL_MS);

  console.log(`cockpit tray running — server ${serverChild ? 'started' : 'reused'} at ${panelUrl}`);
}

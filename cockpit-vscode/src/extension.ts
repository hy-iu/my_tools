import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

interface Health {
  ok: boolean;
  active: number;
  todayCost: number;
  todayTokens: number;
}

function getPort(): number {
  return vscode.workspace.getConfiguration('cockpit').get<number>('port', 4177);
}

function panelUrl(): string {
  return `http://127.0.0.1:${getPort()}`;
}

function httpJson<T>(method: string, url: string, timeoutMs = 2500): Promise<T | undefined> {
  return new Promise((resolve) => {
    const req = http.request(url, { method, timeout: timeoutMs }, (res) => {
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

/** Locate the cockpit (corkpit) checkout: setting > workspace > sibling of extension. */
function findCockpitHome(extDir: string): string | undefined {
  const cfg = vscode.workspace.getConfiguration('cockpit').get<string>('home', '').trim();
  const candidates: string[] = [];
  if (cfg) candidates.push(cfg);
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    candidates.push(path.join(folder.uri.fsPath, 'corkpit'));
    candidates.push(path.join(folder.uri.fsPath, 'cockpit'));
    if (path.basename(folder.uri.fsPath) === 'corkpit') candidates.push(folder.uri.fsPath);
  }
  candidates.push(path.join(extDir, '..', 'corkpit'));
  for (const c of candidates) {
    if (c && existsSync(path.join(c, 'dist', 'cli.js'))) return c;
  }
  return undefined;
}

class CockpitServer {
  private child: ChildProcess | undefined;
  private owned = false;

  async isUp(): Promise<Health | undefined> {
    return httpJson<Health>('GET', `${panelUrl()}/api/health`, 1500);
  }

  /** Ensure the server is reachable; start it if autoStart allows. Returns health if up. */
  async ensure(home: string | undefined, interactive: boolean): Promise<Health | undefined> {
    let health = await this.isUp();
    if (health?.ok) return health;
    const auto = vscode.workspace.getConfiguration('cockpit').get<boolean>('autoStart', true);
    if (!auto && !interactive) return undefined;
    if (!home) {
      if (interactive) {
        void vscode.window.showWarningMessage(
          'Cockpit: could not find the cockpit checkout (needs dist/cli.js). Build it (`npm install && npm run build` in corkpit/) or set "cockpit.home".'
        );
      }
      return undefined;
    }
    this.child = spawn(process.execPath, [path.join(home, 'dist', 'cli.js'), 'serve', '--port', String(getPort())], {
      cwd: home,
      stdio: 'ignore',
      windowsHide: true,
    });
    this.owned = true;
    this.child.on('exit', () => {
      this.child = undefined;
      this.owned = false;
    });
    for (let i = 0; i < 14; i++) {
      await new Promise((r) => setTimeout(r, 500));
      health = await this.isUp();
      if (health?.ok) return health;
    }
    return undefined;
  }

  dispose(): void {
    if (this.owned) this.child?.kill();
  }
}

function webviewHtml(): string {
  const url = panelUrl();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; frame-src ${url};">
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #0d1420; }
  iframe { width: 100%; height: 100%; border: none; display: block; }
</style>
</head>
<body>
  <iframe src="${url}/" title="Cockpit panel"></iframe>
</body>
</html>`;
}

class CockpitViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'cockpit.panel';

  constructor(private readonly server: CockpitServer) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = webviewHtml();
    view.onDidDispose(() => {
      /* nothing to clean up; iframe is stateless */
    });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const server = new CockpitServer();
  const extDir = context.extensionPath;

  const viewProvider = new CockpitViewProvider(server);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CockpitViewProvider.viewType, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // status bar: active sessions + today's cost, refreshed every 30s
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 120);
  status.command = 'cockpit.revealPanel';
  status.text = '$(gauge) cockpit: …';
  status.show();
  context.subscriptions.push(status);

  let busy = false;
  const refreshStatus = async () => {
    if (busy) return;
    busy = true;
    try {
      const health = await server.isUp();
      if (health?.ok) {
        status.text = `$(gauge) cockpit: ${health.active} active · $${Number(health.todayCost).toFixed(2)} today`;
        status.tooltip = 'Cockpit — click to open the panel';
      } else {
        status.text = '$(gauge) cockpit: down';
        status.tooltip = 'Cockpit server not reachable — click to open the panel, or run “Cockpit: Start server”';
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void refreshStatus(), 30_000);
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(timer)));

  const home = () => findCockpitHome(extDir);

  context.subscriptions.push(
    vscode.commands.registerCommand('cockpit.revealPanel', async () => {
      await vscode.commands.executeCommand('cockpit.panel.focus');
      void server.ensure(home(), false).then(refreshStatus);
    }),
    vscode.commands.registerCommand('cockpit.openInEditor', async () => {
      const health = await server.ensure(home(), true);
      if (!health?.ok) return;
      const panel = vscode.window.createWebviewPanel('cockpitPanel', 'Cockpit', vscode.ViewColumn.One, {
        enableScripts: true,
        retainContextWhenHidden: true,
      });
      panel.webview.html = webviewHtml();
    }),
    vscode.commands.registerCommand('cockpit.openInBrowser', async () => {
      const health = await server.ensure(home(), true);
      if (!health?.ok) return;
      void vscode.env.openExternal(vscode.Uri.parse(panelUrl()));
    }),
    vscode.commands.registerCommand('cockpit.startServer', async () => {
      const health = await server.ensure(home(), true);
      if (health?.ok) {
        void vscode.window.showInformationMessage(`Cockpit server running at ${panelUrl()}`);
      } else {
        void vscode.window.showWarningMessage('Cockpit server did not come up — check `node dist/cli.js serve` in the cockpit checkout.');
      }
      void refreshStatus();
    }),
    vscode.commands.registerCommand('cockpit.startTray', async () => {
      const h = findCockpitHome(extDir);
      if (!h) {
        void vscode.window.showWarningMessage('Cockpit: checkout not found — set "cockpit.home" first.');
        return;
      }
      spawn(process.execPath, [path.join(h, 'dist', 'cli.js'), 'tray', '--port', String(getPort())], {
        cwd: h,
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
      }).unref();
      void vscode.window.showInformationMessage('Cockpit tray starting — look for the gauge icon in the system tray.');
    })
  );

  void server.ensure(home(), false).then(refreshStatus);
}

export function deactivate(): void {
  /* child processes are owned per-window; killing the server here would
     disrupt other clients (tray/browser), so leave it running */
}

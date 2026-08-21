/**
 * Assemble the flavor-A sidebar shell: a host-owned toolbar plus a cross-origin
 * `<iframe>` into the running DSH Web UI. The iframe is pure display — it never
 * posts a message back (it cannot; it is cross-origin) — so all host actions
 * ride the toolbar buttons, which call `acquireVsCodeApi()` in the OUTER
 * document (same-origin to the webview).
 */

export interface ShellCsp {
  frameSrc: string;
  connectSrc: string;
}

/**
 * Derive the CSP grants from the configured web URL so an alternate host/port
 * keeps working instead of being silently blocked by `frame-src`.
 */
export function shellCsp(webUrl: string): ShellCsp {
  try {
    const u = new URL(webUrl);
    const host = u.hostname;
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    const origin = u.origin;
    return {
      frameSrc: `${origin}/ http://localhost:${port}/`,
      connectSrc: `${origin} ws://${host}:${port}`,
    };
  } catch {
    return {
      frameSrc: "http://127.0.0.1:3080/ http://localhost:3080/",
      connectSrc: "http://127.0.0.1:3080 ws://127.0.0.1:3080",
    };
  }
}

export function shellHtml(webUrl: string, nonce: string): string {
  const csp = shellCsp(webUrl);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  frame-src ${csp.frameSrc};
  script-src 'nonce-${nonce}';
  style-src 'unsafe-inline';
  connect-src ${csp.connectSrc};
">
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
  body { display: flex; flex-direction: column; font-family: var(--vscode-font-family, sans-serif); }
  #bar { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border, #333); }
  #bar .title { font-weight: 600; font-size: 12px; flex: 1; }
  #bar button { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, inherit); border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; padding: 3px 8px; cursor: pointer; font-size: 11px; }
  #bar button:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.2)); }
  iframe { flex: 1; width: 100%; border: 0; }
</style>
</head>
<body>
  <div id="bar">
    <span class="title">DSH Web</span>
    <button id="open" title="在系统浏览器中打开">↗ 浏览器</button>
    <button id="reload" title="重载 iframe">↻ 重载</button>
  </div>
  <iframe id="shell" src="${webUrl}" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('open').addEventListener('click', () => vscode.postMessage({ kind: 'openInBrowser' }));
    document.getElementById('reload').addEventListener('click', () => vscode.postMessage({ kind: 'reload' }));
  </script>
</body>
</html>`;
}
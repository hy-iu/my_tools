# Cockpit for VS Code

Multi-agent cockpit inside VS Code: the `corkpit/` control plane (Mission
Control, Problem board, Cost Sankey, Knowledge, Adapters/route) embedded as a
sidebar webview, plus a status-bar readout and server/tray lifecycle commands.

## What you get

- **Activity-bar panel** — the full cockpit web UI in a sidebar webview
  (iframe to the local server on `127.0.0.1`).
- **Status bar** — `cockpit: N active · $X.XX today`, refreshed every 30 s;
  click to open the panel.
- **Commands**:
  - `Cockpit: Show sidebar panel`
  - `Cockpit: Open panel in editor`
  - `Cockpit: Open in browser`
  - `Cockpit: Start server` — spawns `node dist/cli.js serve` in the cockpit checkout
  - `Cockpit: Start system tray (Windows)` — spawns `node dist/cli.js tray`

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `cockpit.port` | `4177` | Cockpit server port |
| `cockpit.autoStart` | `true` | Start the server automatically when unreachable |
| `cockpit.home` | `""` | Path to the `corkpit` checkout; auto-detected from the workspace or a sibling folder otherwise |

## Requirements

The cockpit checkout must be built first:

```powershell
cd corkpit
npm install
npm run build
```

## Develop

```powershell
cd cockpit-vscode
npm install
npm run build   # then press F5 in VS Code (Extension Development Host)
```

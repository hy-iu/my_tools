# Cockpit — multi-level agent cockpit

Local control plane for your coding agents: adapter registry (codex,
claude-code, pi, opencode, dsh, antigravity), canonical SQLite store, and a zero-dependency
web UI with Mission Control, Problem board, Cost Sankey, Knowledge notes,
Adapters/route and Skills & MCP. Design rationale:
`2026-08-21-multi-agent-cockpit.md`.

## Session history sources

`ingest` / the re-ingest button parse every local agent's real history:

| Agent | Source | Notes |
|---|---|---|
| pi | `~/.pi/agent/sessions/**/*.jsonl` | native JSONL |
| dsh | `~/.dsh/sessions/**/session.jsonl.zstd` | **multi-frame zstd**, decoded by magic-scan walker in `src/ingest/zstd.ts` (no external deps); provider/model from `request/context` events |
| claude-code | `~/.claude/projects/**/*.jsonl` | usage + `tool_use` blocks incl. `mcp__server__tool` |
| codex | `~/.codex/sessions/**/*.jsonl` | `token_count` deltas, `turn_context` model, `mcp_tool_call_end` normalized to `mcp__server__tool` |
| opencode | `~/.local/share/opencode/opencode.db` | read-only access to opencode's own SQLite (cost included) |
| antigravity | `~/.gemini/antigravity-cli/settings.json` | read/write the persistent `model` field; auth is Google-account OAuth (not touched) |

## Run

```powershell
npm install
npm run build
node dist/cli.js serve            # web UI + API at http://127.0.0.1:4177
```

## Commands

| Command | What it does |
|---|---|
| `serve [--port 4177]` | local web UI + API |
| `tray [--port 4177]` | **Windows tray host**: background server + gauge icon. Menu: per-agent status rows (click → panel filtered to that agent), open panel, re-ingest all sources, check dsh updates (notify only), open dsh web. Tooltip = active sessions + today's cost |
| `ingest` | parse pi/dsh/claude-code/codex/opencode history into the store, sync registry |
| `adapters` | print current config of every adapted application |
| `route --app <id> --provider <id> --model <id>` | switch an application's model/provider (timestamped config backup first) |
| `knowledge --title <t> [--body <b>] [--tags <a,b>]` | add a knowledge note |

## Skills & MCP view

The `Skills & MCP` tab discovers, read-only, from each app's real config:
MCP servers (`~/.claude.json` global + per-project, `~/.codex/config.toml
[mcp_servers.*]`, opencode config, antigravity `~/.agy/config.json`), and
skills/profiles (`~/.claude/skills`, `~/.codex/skills`, `~/.dsh/profiles`,
`~/.gemini/antigravity/`). Below that, MCP **usage**: counts of
`mcp__<server>__<tool>` calls aggregated from all ingested sessions.

## Tray implementation notes (Windows)

- Host: `tray/tray.ps1` (PowerShell WinForms NotifyIcon, zero npm deps),
  orchestrated by `src/tray.ts`.
- IPC is **file-based** (`~/.cockpit/tray/cmd.json` / `event.json`,
  tmp+rename): GUI hosts that read piped stdin get killed ~5 s after start by
  some security tooling (observed empirically on this machine).
- The host keeps a 1×1 full-opacity anchor form owning the message loop —
  near-transparent or window-less GUI hosts also get killed by that tooling.
- Debug: set `COCKPIT_TRAY_DEBUG=<log path>`.

### Auto-start at logon (Windows)

Registered as the scheduled task **`Cockpit Tray`** (trigger: at logon,
no execution time limit, restarts twice on failure). Manage it with:

```powershell
Start-ScheduledTask -TaskName 'Cockpit Tray'     # start now
Stop-ScheduledTask  -TaskName 'Cockpit Tray'     # stop
Get-ScheduledTask   -TaskName 'Cockpit Tray'     # inspect
Unregister-ScheduledTask -TaskName 'Cockpit Tray' -Confirm:$false   # remove
```

Action: `node <repo>\corkpit\dist\cli.js tray --port 4177`.

## Companion VS Code extension

See `../cockpit-vscode` — sidebar webview of this UI, status-bar readout
(active sessions / today's cost), and commands to start the server or tray.

# DSH for VS Code

Run [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) headless tasks
straight from your editor: select some code (or open a file), then run the
**DSH: Run Selection / File as Headless Task** command.

## What it does (P0)

- Resolves the local `dsh` executable (env `DSH_BIN`, known Homebrew paths, then `which`).
- Spawns `dsh --profile headless "<selection-or-file>"` with the workspace root as `cwd`.
- Streams stdout/stderr into the **DSH** output channel and reports exit status.
- Shows a status-bar indicator for idle / running / error state.
- Gives an actionable error (with `DSH_BIN` setup flow) when `dsh` is missing.

## Build

```sh
npm install
npm run build
```

Then press <kbd>F5</kbd> (or run the **Run Extension** launch config) to open an
Extension Development Host.

## Roadmap

- P1: preset/model directory tree, subagent config panel, session-trajectory timeline
  (reads `$DSH_HOME/sessions/**/session.jsonl.zstd`).
- P2: comfy-style tool DAG, entity mesh, optional native `/api` bridge.

See `DESIGN.md` and `notes/dsh-surface-notes.md` for the design and the reverse-engineered
DSH surface contract.
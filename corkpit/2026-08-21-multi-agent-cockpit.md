# Accepted proposal — Multi-level agent cockpit (level model corrected)

## Level model (corrected)

```
super-position         the superposition of ALL levels — not a peer "level" of its own;
                       it is where every level below is overlaid and can be crossed/visualized at once
  ├─ application level   codex / claude-code / antigravity / qoder / opencode / dsh / pi ...
  ├─ model level         GPT / Claude / Qwen / DeepSeek ... (context, capabilities, prices)
  ├─ cost level          OpenAI / OpenRouter / Bailian ... (keys, accounts, limits, actual billed usage)
  ├─ project level       repo / branch / directory
  ├─ subject level       math / GPU / compiler / ...
  ├─ problem level       a concrete task or thread
  └─ knowledge level     reusable findings, decisions, patterns, notes
```

## Why cc-switch is close but not enough

cc-switch mostly operates on one edge: application ↔ provider config. The cockpit must cover every edge at once — application, model, cost, project, subject, problem, knowledge — and visualize their interactions from the super-position plane.

## Phases

### Phase 0 — conservative polishing copilot
- A pi command (e.g. `/polish`) or auto-polish toggle.
- Intercepts the prompt before it reaches the model.
- Runs a low-temperature, strict system prompt that only fixes typos/grammar/formatting.
- Preserves terminology, paths, identifiers, commands, code blocks, and intent.
- Shows a diff for approval by default; never silently changes meaning.
- Configurable against any OpenAI-compatible endpoint (OpenRouter / Bailian / local).

### Phase 1 — unified adapter registry
One canonical config for each application:
- `codex`: `~/.codex/config.toml`
- `claude-code`: `~/.claude/settings.json`, managed providers/keys
- `pi`: `~/.pi/agent/settings.json`, models/providers
- `opencode`: `opencode.json` / config paths
- others: dsh, qoder, antigravity — as their config formats are available

A single "route" action then sets: which application, which model, which provider account, and per-project overrides.

### Phase 2 — canonical data model
Local SQLite store:

- `agents` — codex, claude-code, pi, ...
- `models` — capabilities, context window, price
- `provider_accounts` — OpenAI / OpenRouter / Bailian, keys, limits
- `projects` / `subjects` / `problems`
- `knowledge_notes` — markdown, tags, links
- `sessions` / `turns` / `tool_calls` / `usage` / `cost`

Ingesters parse each application's logs/sessions into that schema. pi sessions are already JSONL, which helps.

### Phase 3 — visualization & interaction
Local web UI (no cloud, no heavy stack):

- **Mission Control grid** — every running/session agent with status, model, cwd, tokens, cost.
- **Problem board** — which problem is worked by which agent/model, with divergence warnings.
- **Cost Sankey** — provider → model → application → project; where the money actually goes.
- **Knowledge graph** — notes linked to problems/agents/sessions; searchable.
- **Cross-level trace** — click any token/cost/item and everything related highlights across all levels.

## Stack recommendation
Node/TypeScript + SQLite + local web UI, because pi is TypeScript and its SDK/session format is TS-friendly. Python/FastAPI is an acceptable alternative.

## Open decisions
1. Start with the polishing copilot or a read-only multi-agent dashboard?
2. TypeScript/Node or Python?
3. Which applications to adapt first (top 3)?
4. Polishing endpoint: OpenRouter, Bailian, or a local OpenAI-compatible endpoint?

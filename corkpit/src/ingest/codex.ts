// codex session ingester.
// Layout: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.
// Records: {timestamp, type, payload}. Key types:
//   session_meta  — payload{id, timestamp, cwd, originator}
//   turn_context  — payload{model, model_provider}
//   event_msg     — payload.type token_count (info.last_token_usage),
//                   user_message, mcp_tool_call_end (invocation.server/tool)
//   response_item — payload.type function_call (name)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { emptyAcc, writeSession, type SessionAcc } from './shared.js';
import type { IngestSource } from './pi.js';

export const CODEX_SESSIONS_ROOT = path.join(homedir(), '.codex', 'sessions');

function findJsonlFiles(dir: string, depth = 0): string[] {
  const out: string[] = [];
  if (depth > 8) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findJsonlFiles(p, depth + 1));
    else if (entry.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function parseSessionFile(file: string, platform: string): SessionAcc | undefined {
  let acc: SessionAcc | undefined;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = typeof o.timestamp === 'string' ? o.timestamp : undefined;
    if (o.type === 'session_meta') {
      acc = emptyAcc(o.payload?.id ?? path.basename(file), 'codex');
      acc.platform = platform;
      acc.cwd = o.payload?.cwd;
      acc.startedAt = o.payload?.timestamp ?? ts;
      acc.lastActivity = acc.startedAt;
      continue;
    }
    if (!acc) continue;
    acc.lastActivity = ts ?? acc.lastActivity;
    if (o.type === 'turn_context') {
      acc.modelId = o.payload?.model ?? acc.modelId;
      acc.providerId = o.payload?.model_provider ?? acc.providerId;
    } else if (o.type === 'event_msg') {
      const p = o.payload ?? {};
      if (p.type === 'thread_settings_applied') {
        // authoritative provider/model per session: session files carry
        // thread_settings.model_provider_id (e.g. meet2ai) + thread_settings.model
        const ts = p.thread_settings ?? {};
        if (ts.model_provider_id) acc.providerId = ts.model_provider_id;
        if (ts.model) acc.modelId = ts.model;
      } else if (p.type === 'token_count') {
        const u = p.info?.last_token_usage ?? {};
        acc.inputTokens += u.input_tokens ?? 0;
        acc.outputTokens += u.output_tokens ?? 0;
        acc.cacheReadTokens += u.cached_input_tokens ?? 0;
        acc.cacheWriteTokens += u.cache_write_input_tokens ?? 0;
        acc.reasoningTokens += u.reasoning_output_tokens ?? 0;
        acc.turns += 1;
        acc.turnRows.push({
          role: 'assistant', ts, modelId: acc.modelId, providerId: acc.providerId,
          inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cost: 0,
        });
      } else if (p.type === 'user_message') {
        acc.turns += 1;
        acc.turnRows.push({ role: 'user', ts, inputTokens: 0, outputTokens: 0, cost: 0 });
      } else if (p.type === 'mcp_tool_call_end') {
        acc.toolCalls += 1;
        const server = p.invocation?.server ?? 'unknown';
        const tool = p.invocation?.tool ?? 'unknown';
        // canonical mcp naming, shared with claude-code's mcp__server__tool
        acc.toolCallRows.push({ name: `mcp__${server}__${tool}`, ts });
      }
    } else if (o.type === 'response_item' && o.payload?.type === 'function_call') {
      acc.toolCalls += 1;
      acc.toolCallRows.push({ name: o.payload?.name ?? 'unknown', ts });
    }
  }
  return acc;
}

export function ingestCodexSessions(db: DatabaseSync, opts: IngestSource = {}): { files: number; sessions: number } {
  const root = opts.home ? path.join(opts.home, '.codex', 'sessions') : CODEX_SESSIONS_ROOT;
  const platform = opts.platform ?? 'local';
  try {
    statSync(root);
  } catch {
    return { files: 0, sessions: 0 };
  }
  let files = 0;
  let sessions = 0;
  for (const file of findJsonlFiles(root)) {
    files += 1;
    try {
      const acc = parseSessionFile(file, platform);
      if (!acc) continue;
      if (writeSession(db, acc)) sessions += 1;
    } catch (e) {
      console.error(`failed to ingest ${file}: ${e}`);
    }
  }
  return { files, sessions };
}

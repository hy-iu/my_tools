import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export const PI_SESSIONS_ROOT = path.join(homedir(), '.pi', 'agent', 'sessions');

interface SessionAcc {
  id: string;
  cwd?: string;
  startedAt?: string;
  lastActivity?: string;
  providerId?: string;
  modelId?: string;
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costTotal: number;
  turnRows: { role: string; ts?: string; modelId?: string; providerId?: string; inputTokens: number; outputTokens: number; cost: number }[];
  toolCallRows: { name: string; ts?: string }[];
}

function findJsonlFiles(dir: string, depth = 0): string[] {
  const out: string[] = [];
  if (depth > 8) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findJsonlFiles(p, depth + 1));
    else if (entry.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function parseSessionFile(file: string): SessionAcc | undefined {
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  let acc: SessionAcc | undefined;
  let currentProvider: string | undefined;
  let currentModel: string | undefined;
  for (const line of lines) {
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === 'session') {
      acc = {
        id: o.id,
        cwd: o.cwd,
        startedAt: o.timestamp,
        lastActivity: o.timestamp,
        turns: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costTotal: 0,
        turnRows: [],
        toolCallRows: [],
      };
    } else if (o.type === 'model_change') {
      currentProvider = o.provider;
      currentModel = o.modelId;
    } else if (o.type === 'message' && acc) {
      const msg = o.message ?? {};
      acc.lastActivity = o.timestamp ?? acc.lastActivity;
      acc.turns += 1;
      if (msg.role === 'assistant') {
        const usage = msg.usage ?? {};
        const cost = usage.cost?.total ?? 0;
        acc.providerId = msg.provider ?? currentProvider ?? acc.providerId;
        acc.modelId = msg.model ?? currentModel ?? acc.modelId;
        acc.inputTokens += usage.input ?? 0;
        acc.outputTokens += usage.output ?? 0;
        acc.cacheReadTokens += usage.cacheRead ?? 0;
        acc.cacheWriteTokens += usage.cacheWrite ?? 0;
        acc.reasoningTokens += usage.reasoning ?? 0;
        acc.costTotal += cost;
        acc.turnRows.push({
          role: 'assistant',
          ts: o.timestamp,
          modelId: msg.model ?? currentModel,
          providerId: msg.provider ?? currentProvider,
          inputTokens: usage.input ?? 0,
          outputTokens: usage.output ?? 0,
          cost,
        });
        for (const c of msg.content ?? []) {
          if (c?.type === 'toolCall') {
            acc.toolCalls += 1;
            acc.toolCallRows.push({ name: c.name ?? c.toolName ?? 'unknown', ts: o.timestamp });
          }
        }
      } else {
        acc.turnRows.push({ role: msg.role ?? 'user', ts: o.timestamp, inputTokens: 0, outputTokens: 0, cost: 0 });
      }
    }
  }
  return acc;
}

export function ingestPiSessions(db: DatabaseSync, root: string = PI_SESSIONS_ROOT): { files: number; sessions: number } {
  let files = 0;
  let sessions = 0;
  let dirOk = true;
  try {
    statSync(root);
  } catch {
    dirOk = false;
  }
  if (!dirOk) return { files: 0, sessions: 0 };

  const upsertSession = db.prepare(`
    INSERT INTO sessions (id, agent_id, cwd, started_at, last_activity, provider_id, model_id,
      turns, tool_calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_total)
    VALUES (?, 'pi', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      cwd = excluded.cwd, started_at = excluded.started_at, last_activity = excluded.last_activity,
      provider_id = CASE WHEN sessions.provider_locked = 1 THEN sessions.provider_id ELSE excluded.provider_id END,
      model_id = excluded.model_id,
      turns = excluded.turns, tool_calls = excluded.tool_calls,
      input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens, cache_write_tokens = excluded.cache_write_tokens,
      reasoning_tokens = excluded.reasoning_tokens, cost_total = excluded.cost_total`);
  const insertTurn = db.prepare(`
    INSERT INTO turns (session_id, role, ts, model_id, provider_id, input_tokens, output_tokens, cost)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertToolCall = db.prepare(`
    INSERT INTO tool_calls (session_id, name, ts) VALUES (?, ?, ?)`);
  const deleteTurns = db.prepare(`DELETE FROM turns WHERE session_id = ?`);
  const deleteToolCalls = db.prepare(`DELETE FROM tool_calls WHERE session_id = ?`);

  for (const file of findJsonlFiles(root)) {
    files += 1;
    const acc = parseSessionFile(file);
    if (!acc) continue;
    db.exec('BEGIN');
    try {
      upsertSession.run(
        acc.id, acc.cwd ?? null, acc.startedAt ?? null, acc.lastActivity ?? null,
        acc.providerId ?? null, acc.modelId ?? null,
        acc.turns, acc.toolCalls, acc.inputTokens, acc.outputTokens,
        acc.cacheReadTokens, acc.cacheWriteTokens, acc.reasoningTokens, acc.costTotal,
      );
      deleteTurns.run(acc.id);
      deleteToolCalls.run(acc.id);
      for (const t of acc.turnRows) {
        insertTurn.run(acc.id, t.role, t.ts ?? null, t.modelId ?? null, t.providerId ?? null, t.inputTokens, t.outputTokens, t.cost);
      }
      for (const tc of acc.toolCallRows) {
        insertToolCall.run(acc.id, tc.name, tc.ts ?? null);
      }
      db.exec('COMMIT');
      sessions += 1;
    } catch (e) {
      db.exec('ROLLBACK');
      console.error(`failed to ingest ${file}: ${e}`);
    }
  }
  return { files, sessions };
}

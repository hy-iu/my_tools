// Shared upsert plumbing for all ingesters.
import type { DatabaseSync } from 'node:sqlite';

export interface TurnRow {
  role: string;
  ts?: string;
  modelId?: string;
  providerId?: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface SessionAcc {
  id: string;
  agentId: string;
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
  turnRows: TurnRow[];
  toolCallRows: { name: string; ts?: string }[];
}

export function emptyAcc(id: string, agentId: string): SessionAcc {
  return {
    id, agentId, turns: 0, toolCalls: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, costTotal: 0, turnRows: [], toolCallRows: [],
  };
}

/** Replace one session's rows atomically. Returns true on success. */
export function writeSession(db: DatabaseSync, acc: SessionAcc): boolean {
  // unknown / empty source (agent) -> fall back to the provider account so the
  // source column stays meaningful for any ingester that can't name its agent.
  if (!acc.agentId || acc.agentId === 'unknown') {
    acc.agentId = acc.providerId && acc.providerId !== 'unknown' ? acc.providerId : 'unknown';
  }
  const upsert = db.prepare(`
    INSERT INTO sessions (id, agent_id, cwd, started_at, last_activity, provider_id, model_id,
      turns, tool_calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      agent_id = excluded.agent_id, cwd = excluded.cwd,
      started_at = excluded.started_at, last_activity = excluded.last_activity,
      provider_id = CASE WHEN sessions.provider_locked = 1 THEN sessions.provider_id ELSE excluded.provider_id END,
      model_id = excluded.model_id,
      turns = excluded.turns, tool_calls = excluded.tool_calls,
      input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens, cache_write_tokens = excluded.cache_write_tokens,
      reasoning_tokens = excluded.reasoning_tokens, cost_total = excluded.cost_total`);
  const insertTurn = db.prepare(`
    INSERT INTO turns (session_id, role, ts, model_id, provider_id, input_tokens, output_tokens, cost)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertToolCall = db.prepare(`INSERT INTO tool_calls (session_id, name, ts) VALUES (?, ?, ?)`);
  db.exec('BEGIN');
  try {
    upsert.run(
      acc.id, acc.agentId, acc.cwd ?? null, acc.startedAt ?? null, acc.lastActivity ?? null,
      acc.providerId ?? null, acc.modelId ?? null,
      acc.turns, acc.toolCalls, acc.inputTokens, acc.outputTokens,
      acc.cacheReadTokens, acc.cacheWriteTokens, acc.reasoningTokens, acc.costTotal,
    );
    db.prepare(`DELETE FROM turns WHERE session_id = ?`).run(acc.id);
    db.prepare(`DELETE FROM tool_calls WHERE session_id = ?`).run(acc.id);
    for (const t of acc.turnRows) {
      insertTurn.run(acc.id, t.role, t.ts ?? null, t.modelId ?? null, t.providerId ?? null, t.inputTokens, t.outputTokens, t.cost);
    }
    for (const tc of acc.toolCallRows) {
      insertToolCall.run(acc.id, tc.name, tc.ts ?? null);
    }
    db.exec('COMMIT');
    return true;
  } catch (e) {
    db.exec('ROLLBACK');
    console.error(`failed to ingest session ${acc.id}: ${e}`);
    return false;
  }
}

export function epochMsToIso(ms: unknown): string | undefined {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n).toISOString();
}

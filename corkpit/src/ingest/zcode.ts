// zcode session ingester — reads zcode's own SQLite store read-only.
// Layout: ~/.zcode/cli/db/db.sqlite
//   session      — id, directory (cwd), title, time_created/time_updated (epoch ms)
//   model_usage  — per model request: provider_id, model_id, token fields, timestamps
//   tool_usage   — per tool call: tool_name, timestamps
// zcode is subscription-based (no cost field anywhere), so cost stays 0;
// tokens/turns/tools carry the usage signal.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { emptyAcc, writeSession, type SessionAcc } from './shared.js';
import type { IngestSource } from './pi.js';

export const ZCODE_DB = path.join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite');

function toIso(v: unknown): string | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n).toISOString();
}

export function ingestZcodeSessions(db: DatabaseSync, opts: IngestSource = {}): { files: number; sessions: number } {
  const dbPath = opts.home ? path.join(opts.home, '.zcode', 'cli', 'db', 'db.sqlite') : ZCODE_DB;
  const platform = opts.platform ?? 'local';
  if (!existsSync(dbPath)) return { files: 0, sessions: 0 };
  let src: DatabaseSync;
  try {
    src = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    console.error(`zcode db unreadable (${dbPath}): ${e}`);
    return { files: 0, sessions: 0 };
  }
  let sessions = 0;
  try {
    // the zcode client may be writing (it usually is); give readers room
    try {
      src.exec('PRAGMA busy_timeout = 3000;');
    } catch {
      /* best effort */
    }
    const hasTable = src.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='session'`).get();
    if (!hasTable) return { files: 0, sessions: 0 };

    const rows = src.prepare(`
      SELECT s.id, s.directory, s.title, s.time_created, s.time_updated,
        (SELECT COUNT(*) FROM turn_usage t WHERE t.session_id = s.id) AS turns,
        COALESCE((SELECT SUM(m.input_tokens) FROM model_usage m WHERE m.session_id = s.id), 0) AS input_tokens,
        COALESCE((SELECT SUM(m.output_tokens) FROM model_usage m WHERE m.session_id = s.id), 0) AS output_tokens,
        COALESCE((SELECT SUM(m.reasoning_tokens) FROM model_usage m WHERE m.session_id = s.id), 0) AS reasoning_tokens,
        COALESCE((SELECT SUM(m.cache_read_input_tokens) FROM model_usage m WHERE m.session_id = s.id), 0) AS cache_read,
        COALESCE((SELECT SUM(m.cache_creation_input_tokens) FROM model_usage m WHERE m.session_id = s.id), 0) AS cache_write,
        (SELECT COUNT(*) FROM tool_usage tu WHERE tu.session_id = s.id) AS tool_calls
      FROM session s`).all() as any[];

    const latestModel = src.prepare(`
      SELECT model_id, provider_id, completed_at FROM model_usage
      WHERE session_id = ? AND model_id IS NOT NULL
      ORDER BY completed_at DESC LIMIT 1`);
    const turnRows = src.prepare(`
      SELECT model_id, provider_id, input_tokens, output_tokens, completed_at
      FROM model_usage WHERE session_id = ? AND (input_tokens > 0 OR output_tokens > 0)
      ORDER BY completed_at`);
    const toolRows = src.prepare(`
      SELECT tool_name, started_at FROM tool_usage WHERE session_id = ? ORDER BY started_at`);

    for (const r of rows) {
      const acc: SessionAcc = emptyAcc(r.id, 'zcode');
      acc.platform = platform;
      acc.cwd = r.directory ?? undefined;
      acc.startedAt = toIso(r.time_created);
      acc.lastActivity = toIso(r.time_updated) ?? acc.startedAt;
      acc.turns = Number(r.turns) || 0;
      acc.toolCalls = Number(r.tool_calls) || 0;
      acc.inputTokens = Number(r.input_tokens) || 0;
      acc.outputTokens = Number(r.output_tokens) || 0;
      acc.reasoningTokens = Number(r.reasoning_tokens) || 0;
      acc.cacheReadTokens = Number(r.cache_read) || 0;
      acc.cacheWriteTokens = Number(r.cache_write) || 0;
      const lm = latestModel.get(r.id) as any;
      if (lm) {
        acc.modelId = lm.model_id;
        acc.providerId = lm.provider_id;
      }
      for (const t of turnRows.all(r.id) as any[]) {
        acc.turnRows.push({
          role: 'assistant', ts: toIso(t.completed_at), modelId: t.model_id, providerId: t.provider_id,
          inputTokens: Number(t.input_tokens) || 0, outputTokens: Number(t.output_tokens) || 0, cost: 0,
        });
      }
      for (const t of toolRows.all(r.id) as any[]) {
        acc.toolCallRows.push({ name: t.tool_name ?? 'unknown', ts: toIso(t.started_at) });
      }
      if (writeSession(db, acc)) sessions += 1;
    }
  } catch (e) {
    console.error(`zcode db not readable (${dbPath}): ${e}`);
    return { files: 0, sessions };
  } finally {
    try {
      src.close();
    } catch {
      /* ignore */
    }
  }
  return { files: 1, sessions };
}

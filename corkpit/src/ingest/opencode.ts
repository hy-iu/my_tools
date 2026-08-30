// opencode session ingester — reads opencode's own SQLite store read-only.
// Layout: ~/.local/share/opencode/opencode.db, table `session` with
// id, directory, title, time_created, time_updated, model, cost,
// tokens_input/output/reasoning/cache_read/cache_write.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { emptyAcc, writeSession } from './shared.js';
import type { SessionAcc } from './shared.js';
import type { IngestSource } from './pi.js';

export const OPENCODE_DB = path.join(homedir(), '.local', 'share', 'opencode', 'opencode.db');

// opencode stores model as a JSON string like
// {"id":"deepseek-v4-pro","providerID":"deepseek","variant":"max"}.
// Flatten to "id (variant)" and surface providerID as the provider account.
function flattenModel(raw: unknown): { modelId?: string; providerId?: string } {
  if (typeof raw !== 'string') return { modelId: raw as string };
  const s = raw.trim();
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      const id = j?.id ? String(j.id) : undefined;
      const variant = j?.variant ? String(j.variant) : undefined;
      const providerId = j?.providerID ? String(j.providerID) : (j?.provider ? String(j.provider) : undefined);
      return { modelId: id ? (variant ? `${id} (${variant})` : id) : undefined, providerId };
    } catch {
      /* not JSON — keep raw */
    }
  }
  return { modelId: raw };
}

// opencode stores epoch millis; normalize defensively
function toIso(v: unknown): string | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n > 1e12 ? n : n * 1000).toISOString();
}

export function ingestOpencodeSessions(db: DatabaseSync, opts: IngestSource = {}): { files: number; sessions: number } {
  const dbPath = opts.home ? path.join(opts.home, '.local', 'share', 'opencode', 'opencode.db') : OPENCODE_DB;
  const platform = opts.platform ?? 'local';
  if (!existsSync(dbPath)) return { files: 0, sessions: 0 };
  let src: DatabaseSync;
  try {
    src = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    console.error(`opencode db unreadable (${dbPath}): ${e}`);
    return { files: 0, sessions: 0 };
  }
  let sessions = 0;
  try {
    const hasTable = src.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='session'`).get();
    if (!hasTable) return { files: 0, sessions: 0 };
    const rows = src.prepare(`SELECT * FROM session`).all() as any[];
    for (const r of rows) {
      // scope the id per platform so the same store on host and WSL stays distinct
      const acc: SessionAcc = emptyAcc(r.id, 'opencode');
      acc.platform = platform;
      acc.cwd = r.directory ?? undefined;
      acc.startedAt = toIso(r.time_created);
      acc.lastActivity = toIso(r.time_updated) ?? acc.startedAt;
      const flat = flattenModel(r.model);
      acc.modelId = flat.modelId ?? undefined;
      if (flat.providerId) acc.providerId = flat.providerId;
      acc.costTotal = Number(r.cost) || 0;
      acc.inputTokens = Number(r.tokens_input) || 0;
      acc.outputTokens = Number(r.tokens_output) || 0;
      acc.reasoningTokens = Number(r.tokens_reasoning) || 0;
      acc.cacheReadTokens = Number(r.tokens_cache_read) || 0;
      acc.cacheWriteTokens = Number(r.tokens_cache_write) || 0;
      if (writeSession(db, acc)) sessions += 1;
    }
  } catch (e) {
    // e.g. WAL databases on \\wsl.localhost: byte-range locking doesn't work
    // through the 9P bridge → "database is locked". Report, don't propagate —
    // one unreadable store must not kill the whole platform's ingest.
    console.error(`opencode db not readable (${dbPath}): ${e}`);
    return { files: 0, sessions: 0 };
  } finally {
    try {
      src.close();
    } catch {
      /* ignore */
    }
  }
  return { files: 1, sessions };
}

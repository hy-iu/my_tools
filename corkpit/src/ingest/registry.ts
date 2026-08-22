import type { DatabaseSync } from 'node:sqlite';
import { adapters } from '../adapters/index.js';

/** Sync agents, provider accounts, models, and projects from adapter snapshots into the DB. */
export function syncRegistry(db: DatabaseSync): void {
  const upsertAgent = db.prepare(`
    INSERT INTO agents (id, display_name) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name`);
  const upsertProvider = db.prepare(`
    INSERT INTO provider_accounts (id, display_name, base_url, key_source) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, base_url = excluded.base_url, key_source = excluded.key_source`);
  const upsertModel = db.prepare(`
    INSERT INTO models (id, provider_id, display_name, context_window, max_tokens, reasoning) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id, provider_id) DO UPDATE SET display_name = excluded.display_name,
      context_window = excluded.context_window, max_tokens = excluded.max_tokens, reasoning = excluded.reasoning`);
  const upsertProject = db.prepare(`
    INSERT INTO projects (path, name) VALUES (?, ?)
    ON CONFLICT(path) DO UPDATE SET name = excluded.name`);

  db.exec('BEGIN');
  try {
    for (const adapter of adapters) {
      upsertAgent.run(adapter.id, adapter.displayName);
      let snapshot;
      try {
        snapshot = adapter.read();
      } catch {
        continue;
      }
      for (const p of snapshot.providers) {
        upsertProvider.run(p.id, p.displayName, p.baseUrl ?? null, p.keySource ?? null);
      }
      for (const m of snapshot.models) {
        if (!m.providerId) continue;
        upsertModel.run(m.id, m.providerId, m.displayName ?? null, m.contextWindow ?? null, m.maxTokens ?? null, m.reasoning ? 1 : 0);
      }
    }
    const sessions = db.prepare(`SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL AND cwd != ''`).all() as { cwd: string }[];
    for (const { cwd } of sessions) {
      upsertProject.run(cwd, cwd.split('/').filter(Boolean).pop() ?? cwd);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

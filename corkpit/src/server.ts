import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { adapters, getAdapter } from './adapters/index.js';
import { ingestAll } from './ingest/all.js';
import { syncRegistry } from './ingest/registry.js';
import { discoverCapabilities, mcpUsage } from './capabilities.js';
import { canonicalProjectPath } from './paths.js';
import { discoverPlatforms } from './platforms.js';
import { probeFleet } from './fleet.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

function projName(cwd: string | null | undefined): string {
  return (cwd ?? '?').split(/[\/\\]/).filter(Boolean).pop() || cwd || '?';
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      data += c;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sessionRows(db: DatabaseSync) {
  return db.prepare(`
    SELECT s.*,
      CASE WHEN s.last_activity IS NOT NULL
        AND (julianday('now') - julianday(s.last_activity)) * 86400000 < ${ACTIVE_WINDOW_MS}
      THEN 1 ELSE 0 END AS active
    FROM sessions s ORDER BY s.last_activity DESC LIMIT 5000`).all();
}

function sankeyData(db: DatabaseSync, metric: 'tokens' | 'cost') {
  const rows = db.prepare(`
    SELECT provider_id, model_id, agent_id, cwd,
      SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + reasoning_tokens) AS tokens,
      SUM(cost_total) AS cost
    FROM sessions GROUP BY provider_id, model_id, agent_id, cwd`).all() as any[];
  const value = (r: any) => (metric === 'cost' ? r.cost : r.tokens) || 0;

  const nodes = new Map<string, { id: string; label: string; layer: number; value: number }>();
  const links: { source: string; target: string; value: number }[] = [];
  const addLink = (a: string, b: string, v: number) => {
    if (v <= 0) return;
    const existing = links.find((l) => l.source === a && l.target === b);
    if (existing) existing.value += v;
    else links.push({ source: a, target: b, value: v });
  };
  const node = (id: string, label: string, layer: number) => {
    if (!nodes.has(id)) nodes.set(id, { id, label, layer, value: 0 });
    return nodes.get(id)!;
  };

  for (const r of rows) {
    const v = value(r);
    if (v <= 0) continue;
    const p = node(`p:${r.provider_id ?? '?'}`, r.provider_id ?? 'unknown', 0);
    const m = node(`m:${r.model_id ?? '?'}`, r.model_id ?? 'unknown', 1);
    const a = node(`a:${r.agent_id}`, r.agent_id, 2);
    // group the project layer by canonical path so F:\x, /mnt/f/x and
    // \\wsl.localhost\<d>\... collapse into one project node
    const canon = canonicalProjectPath(r.cwd, 'local');
    const pr = node(`j:${canon}`, projName(canon), 3);
    p.value += v; m.value += v; a.value += v; pr.value += v;
    addLink(p.id, m.id, v);
    addLink(m.id, a.id, v);
    addLink(a.id, pr.id, v);
  }
  return { nodes: [...nodes.values()], links };
}

export function createServer(db: DatabaseSync): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === 'GET /api/adapters') {
        return json(res, 200, adapters.map((a) => a.read()));
      }
      if (route === 'POST /api/route') {
        const body = await readBody(req);
        const adapter = getAdapter(body.app);
        if (!adapter) return json(res, 404, { ok: false, message: `unknown app: ${body.app}` });
        if (!adapter.route) return json(res, 400, { ok: false, message: `${body.app} does not support routing` });
        const snapshot = adapter.read();
        if (snapshot.providers.length && !snapshot.providers.some((p) => p.id === body.providerId)) {
          return json(res, 400, { ok: false, message: `unknown provider for ${body.app}: ${body.providerId}` });
        }
        if (snapshot.models.length && !snapshot.models.some((m) => m.id === body.modelId && (!m.providerId || m.providerId === body.providerId))) {
          return json(res, 400, { ok: false, message: `unknown model for ${body.app}/${body.providerId}: ${body.modelId}` });
        }
        const result = adapter.route({ providerId: body.providerId, modelId: body.modelId });
        if (result.ok) {
          syncRegistry(db);
        }
        return json(res, result.ok ? 200 : 400, result);
      }
      if (route === 'POST /api/ingest') {
        const r = ingestAll(db);
        syncRegistry(db);
        return json(res, 200, { ok: true, ...r });
      }
      if (route === 'GET /api/capabilities') {
        return json(res, 200, { apps: await discoverCapabilities(), mcpUsage: mcpUsage(db) });
      }
      if (route === 'GET /api/platforms') {
        return json(res, 200, await discoverPlatforms());
      }
      if (route === 'GET /api/export') {
        // read-only snapshot for fleet peers to aggregate
        const health = {
          ok: true,
          active: (sessionRows(db) as any[]).filter((s) => s.active).length,
          label: process.env.COCKPIT_LABEL ?? `${process.platform} · ${hostname()}`,
        };
        return json(res, 200, {
          health,
          agents: db.prepare(`
            SELECT agent_id, COUNT(*) AS sessions, MAX(last_activity) AS last_activity,
              SUM(CASE WHEN last_activity IS NOT NULL
                AND (julianday('now') - julianday(last_activity)) * 86400000 < ${ACTIVE_WINDOW_MS}
                THEN 1 ELSE 0 END) AS active
            FROM sessions GROUP BY agent_id ORDER BY sessions DESC`).all(),
          totals: db.prepare(`
            SELECT COUNT(*) AS sessions, COALESCE(SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens+reasoning_tokens),0) AS tokens,
              COALESCE(SUM(cost_total),0) AS cost FROM sessions`).get(),
          platforms: await discoverPlatforms().then((ps) => ps.map((p) => ({ id: p.id, label: p.label, kind: p.kind, available: p.available }))),
        });
      }
      if (route === 'GET /api/fleet') {
        return json(res, 200, await probeFleet());
      }
      if (route === 'GET /api/sessions') {
        return json(res, 200, sessionRows(db));
      }
      if (route.startsWith('GET /api/session/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/session/'.length));
        // ids may carry a platform slug prefix: wsl-Ubuntu-26.04__<uuid>
        if (!/^[\w.-]{1,200}$/.test(id)) {
          return json(res, 400, { ok: false, message: 'invalid session id' });
        }
        const session = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as any;
        if (!session) return json(res, 404, { ok: false, message: 'session not found' });
        const turns = db.prepare(`
          SELECT role, ts, model_id, provider_id, input_tokens, output_tokens, cost
          FROM turns WHERE session_id = ? ORDER BY rowid`).all(id);
        const tools = db.prepare(`
          SELECT name, COUNT(*) AS count, MAX(ts) AS last_ts
          FROM tool_calls WHERE session_id = ? GROUP BY name ORDER BY count DESC`).all(id);
        const problems = db.prepare(`
          SELECT p.id, p.title FROM problems p
          JOIN problem_sessions ps ON ps.problem_id = p.id WHERE ps.session_id = ?`).all(id);
        return json(res, 200, { session, turns, tools, problems });
      }
      if (route === 'GET /api/daily') {
        const rows = db.prepare(`
          SELECT date(last_activity) AS day,
            COUNT(*) AS sessions,
            COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + reasoning_tokens), 0) AS tokens,
            COALESCE(SUM(cost_total), 0) AS cost,
            COALESCE(SUM(tool_calls), 0) AS tool_calls
          FROM sessions WHERE last_activity IS NOT NULL
            AND julianday('now') - julianday(last_activity) < 28
          GROUP BY day ORDER BY day`).all() as any[];
        const byDay = new Map(rows.map((r) => [r.day, r]));
        const out: any[] = [];
        for (let i = 27; i >= 0; i--) {
          const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
          out.push(byDay.get(day) ?? { day, sessions: 0, tokens: 0, cost: 0, tool_calls: 0 });
        }
        return json(res, 200, out);
      }
      if (route === 'GET /api/tools') {
        return json(res, 200, db.prepare(`
          SELECT name, COUNT(*) AS count FROM tool_calls GROUP BY name ORDER BY count DESC LIMIT 20`).all());
      }
      if (route === 'GET /api/sankey') {
        const metric = url.searchParams.get('metric') === 'cost' ? 'cost' : 'tokens';
        return json(res, 200, sankeyData(db, metric));
      }
      if (route === 'GET /api/problems') {
        const problems = db.prepare(`
          SELECT p.*, s.name AS subject_name,
            (SELECT COUNT(*) FROM problem_sessions ps WHERE ps.problem_id = p.id) AS session_count
          FROM problems p LEFT JOIN subjects s ON s.id = p.subject_id ORDER BY p.id DESC`).all();
        const assignments = db.prepare(`
          SELECT ps.problem_id, ps.session_id, se.agent_id, se.model_id, se.cwd
          FROM problem_sessions ps JOIN sessions se ON se.id = ps.session_id`).all();
        return json(res, 200, { problems, assignments });
      }
      if (route === 'POST /api/problems') {
        const body = await readBody(req);
        if (!body.title) return json(res, 400, { ok: false, message: 'title required' });
        let subjectId: number | null = null;
        if (body.subject) {
          db.prepare(`INSERT INTO subjects (name) VALUES (?) ON CONFLICT(name) DO NOTHING`).run(body.subject);
          subjectId = (db.prepare(`SELECT id FROM subjects WHERE name = ?`).get(body.subject) as any).id;
        }
        const r = db.prepare(`INSERT INTO problems (title, subject_id) VALUES (?, ?)`).run(body.title, subjectId);
        return json(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
      }
      if (route.startsWith('POST /api/problems/') && url.pathname.endsWith('/sessions')) {
        const problemId = Number(url.pathname.split('/')[3]);
        if (!Number.isInteger(problemId) || problemId < 1) {
          return json(res, 400, { ok: false, message: 'invalid problem id' });
        }
        const body = await readBody(req);
        db.prepare(`INSERT OR IGNORE INTO problem_sessions (problem_id, session_id) VALUES (?, ?)`).run(problemId, body.sessionId);
        return json(res, 200, { ok: true });
      }
      if (route === 'GET /api/knowledge') {
        const notes = db.prepare(`SELECT * FROM knowledge_notes ORDER BY id DESC`).all();
        const links = db.prepare(`SELECT * FROM note_links`).all();
        const subjects = db.prepare(`SELECT * FROM subjects ORDER BY name`).all();
        return json(res, 200, { notes, links, subjects });
      }
      if (route === 'POST /api/knowledge') {
        const body = await readBody(req);
        if (!body.title) return json(res, 400, { ok: false, message: 'title required' });
        const r = db.prepare(`INSERT INTO knowledge_notes (title, body, tags) VALUES (?, ?, ?)`)
          .run(body.title, body.body ?? '', body.tags ?? '');
        const noteId = Number(r.lastInsertRowid);
        for (const link of body.links ?? []) {
          db.prepare(`INSERT OR IGNORE INTO note_links (note_id, target_type, target_id) VALUES (?, ?, ?)`)
            .run(noteId, link.type, String(link.id));
        }
        return json(res, 200, { ok: true, id: noteId });
      }
      if (route === 'GET /api/health') {
        const active = db.prepare(`
          SELECT COUNT(*) AS n FROM sessions
          WHERE last_activity IS NOT NULL
            AND (julianday('now') - julianday(last_activity)) * 86400000 < ${ACTIVE_WINDOW_MS}`).get() as any;
        const today = db.prepare(`
          SELECT COALESCE(SUM(cost_total), 0) AS cost,
            COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + reasoning_tokens), 0) AS tokens
          FROM sessions WHERE date(last_activity) = date('now')`).get() as any;
        const agentRows = db.prepare(`
          SELECT agent_id,
            SUM(CASE WHEN last_activity IS NOT NULL
              AND (julianday('now') - julianday(last_activity)) * 86400000 < ${ACTIVE_WINDOW_MS}
              THEN 1 ELSE 0 END) AS active,
            COUNT(*) AS sessions,
            MAX(last_activity) AS last_activity
          FROM sessions GROUP BY agent_id ORDER BY active DESC, last_activity DESC`).all();
        return json(res, 200, {
          ok: true,
          active: active.n ?? 0,
          todayCost: today.cost ?? 0,
          todayTokens: today.tokens ?? 0,
          agents: agentRows,
          apps: adapters.map((a) => a.id),
          platforms: (await discoverPlatforms()).map((p) => ({ id: p.id, label: p.label, kind: p.kind, available: p.available })),
          version: '0.2.0',
        });
      }
      if (route === 'GET /api/providers') {
        // picker candidates: registered provider accounts + any provider id
        // seen on sessions (so user can re-apply a previously seen one).
        const acc = db.prepare(`SELECT id, display_name, base_url, key_source FROM provider_accounts ORDER BY display_name`).all() as any[];
        const seen = new Set(acc.map((a) => a.id));
        const fromSessions = (db.prepare(`SELECT DISTINCT provider_id FROM sessions WHERE provider_id IS NOT NULL AND provider_id != '' ORDER BY provider_id`).all() as any[])
          .filter((r) => !seen.has(r.provider_id))
          .map((r) => ({ id: r.provider_id, display_name: r.provider_id, base_url: null, key_source: null }));
        return json(res, 200, [...acc, ...fromSessions]);
      }
      if (route === 'POST /api/session-provider') {
        // manually assign an account to a set of sessions. A never-seen
        // provider is remembered so it appears in the picker next time.
        // Reset (reset=true or providerId === '__reset__') drops any manual
        // assignment, unlocks the sessions, and RE-READS the config: the
        // ingesters re-derive the provider from each session's source data.
        const body = await readBody(req);
        const ids = Array.isArray(body.sessionIds) ? body.sessionIds.filter((x: unknown) => typeof x === 'string' && x) : [];
        if (!ids.length) return json(res, 400, { ok: false, message: 'no sessionIds' });
        const reset = body.reset === true || body.providerId === '__reset__' || body.providerId === '__clear__';
        db.exec('BEGIN');
        try {
          const ph = ids.map(() => '?').join(',');
          const r = reset
            ? db.prepare(`UPDATE sessions SET provider_id = NULL, provider_locked = 0 WHERE id IN (${ph})`).run(...ids)
            : (() => {
                const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
                if (!providerId) throw new Error('providerId required');
                const exists = db.prepare(`SELECT 1 FROM provider_accounts WHERE id = ?`).get(providerId);
                if (!exists) {
                  const display = typeof body.displayName === 'string' && body.displayName.trim() ? body.displayName.trim() : providerId;
                  db.prepare(`INSERT INTO provider_accounts (id, display_name) VALUES (?, ?)`).run(providerId, display);
                }
                return db.prepare(`UPDATE sessions SET provider_id = ?, provider_locked = 1 WHERE id IN (${ph})`).run(providerId, ...ids);
              })();
          db.exec('COMMIT');
          if (reset) {
            // really "reset config read": let the ingesters re-derive them.
            ingestAll(db);
            syncRegistry(db);
          }
          return json(res, 200, { ok: true, updated: r.changes, reingested: reset });
        } catch (e) {
          db.exec('ROLLBACK');
          return json(res, 400, { ok: false, message: String(e) });
        }
      }
      if (route === 'GET /api/overview') {
        return json(res, 200, {
          agents: db.prepare(`SELECT * FROM agents`).all(),
          providers: db.prepare(`SELECT * FROM provider_accounts`).all(),
          models: db.prepare(`SELECT * FROM models`).all(),
          projects: db.prepare(`SELECT * FROM projects`).all(),
          totals: db.prepare(`
            SELECT COUNT(*) AS sessions, COALESCE(SUM(input_tokens+output_tokens),0) AS tokens,
              COALESCE(SUM(cost_total),0) AS cost, COALESCE(SUM(tool_calls),0) AS tool_calls
            FROM sessions`).get(),
        });
      }
      // static UI
      const rel = path.normalize(url.pathname).replace(/^([/\\])+/, '');
      const filePath = path.resolve(UI_DIR, rel || 'index.html');
      if (!filePath.startsWith(path.resolve(UI_DIR) + path.sep)) {
        return json(res, 403, { ok: false, message: 'forbidden' });
      }
      if (existsSync(filePath)) {
        const type = filePath.endsWith('.js') ? 'text/javascript' : filePath.endsWith('.css') ? 'text/css' : 'text/html';
        // never cache: local tool, files change between edits; no-store also
        // makes a hard reload (Ctrl+F5) unnecessary.
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        return res.end(readFileSync(filePath));
      }
      return json(res, 404, { ok: false, message: 'not found' });
    } catch (e) {
      return json(res, 500, { ok: false, message: String(e) });
    }
  });
  return server;
}

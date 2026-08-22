import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { adapters, getAdapter } from './adapters/index.js';
import { ingestPiSessions } from './ingest/pi.js';
import { syncRegistry } from './ingest/registry.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

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
    FROM sessions s ORDER BY s.last_activity DESC LIMIT 500`).all();
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
    const proj = (r.cwd ?? '').split('/').filter(Boolean).pop() || r.cwd || '?';
    const pr = node(`j:${r.cwd ?? '?'}`, proj, 3);
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
        const r = ingestPiSessions(db);
        syncRegistry(db);
        return json(res, 200, { ok: true, ...r });
      }
      if (route === 'GET /api/sessions') {
        return json(res, 200, sessionRows(db));
      }
      if (route.startsWith('GET /api/session/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/session/'.length));
        if (!/^[\w.-]{1,128}$/.test(id)) {
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
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
        return res.end(readFileSync(filePath));
      }
      return json(res, 404, { ok: false, message: 'not found' });
    } catch (e) {
      return json(res, 500, { ok: false, message: String(e) });
    }
  });
  return server;
}

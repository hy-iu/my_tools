// grok-cli session ingester.
// Layout: ~/.grok/sessions/<url-encoded-cwd>/<sessionId>/chat_history.jsonl
// with {type:"system"|"user"|"assistant", content} records. Sparse: no usage,
// no timestamps per record — session times come from file mtimes, cwd from
// the URL-encoded directory name.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { emptyAcc, writeSession, type SessionAcc } from './shared.js';
import type { IngestSource } from './pi.js';

export const GROK_SESSIONS_ROOT = path.join(homedir(), '.grok', 'sessions');

function ingestHistory(db: DatabaseSync, file: string, platform: string): boolean {
  const sessionId = path.basename(path.dirname(file));
  if (!/^[\w.-]{6,128}$/.test(sessionId)) return false;
  // <root>/<url-encoded cwd>/<sessionId>/chat_history.jsonl
  const cwdSeg = path.basename(path.dirname(path.dirname(file)));
  let cwd: string | undefined;
  try {
    cwd = decodeURIComponent(cwdSeg);
  } catch {
    cwd = cwdSeg;
  }
  const acc: SessionAcc = emptyAcc(sessionId, 'grok');
  acc.platform = platform;
  acc.cwd = cwd;
  let started: string | undefined;
  try {
    acc.startedAt = acc.lastActivity = new Date(statSync(file).mtimeMs).toISOString();
  } catch {
    /* keep undefined */
  }
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = typeof o.timestamp === 'string' ? o.timestamp : undefined;
    started = started ?? ts;
    acc.lastActivity = ts ?? acc.lastActivity;
    if (o.type === 'assistant') {
      acc.turns += 1;
      if (o.model) acc.modelId = o.model;
      acc.turnRows.push({ role: 'assistant', ts, modelId: acc.modelId, inputTokens: 0, outputTokens: 0, cost: 0 });
    } else if (o.type === 'user') {
      acc.turns += 1;
      acc.turnRows.push({ role: 'user', ts, inputTokens: 0, outputTokens: 0, cost: 0 });
    }
  }
  acc.startedAt = started ?? acc.startedAt;
  return writeSession(db, acc);
}

export function ingestGrokSessions(db: DatabaseSync, opts: IngestSource = {}): { files: number; sessions: number } {
  const root = opts.home ? path.join(opts.home, '.grok', 'sessions') : GROK_SESSIONS_ROOT;
  const platform = opts.platform ?? 'local';
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return { files: 0, sessions: 0 };
  }
  let files = 0;
  let sessions = 0;
  for (const proj of entries) {
    if (!proj.isDirectory()) continue;
    const projDir = path.join(root, proj.name);
    let ids;
    try {
      ids = readdirSync(projDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const id of ids) {
      if (!id.isDirectory()) continue;
      const file = path.join(projDir, id.name, 'chat_history.jsonl');
      try {
        statSync(file);
      } catch {
        continue;
      }
      files += 1;
      try {
        if (ingestHistory(db, file, platform)) sessions += 1;
      } catch (e) {
        console.error(`failed to ingest ${file}: ${e}`);
      }
    }
  }
  return { files, sessions };
}

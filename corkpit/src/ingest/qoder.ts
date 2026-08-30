// qoder / qoder-cn session ingester.
// Layout: ~/.qoder/projects/<mangled-cwd>/<sessionId>.jsonl (same shape for
// ~/.qoder-cn). Claude-Code-like records:
//   workspace-directories — {directories:[cwd]}
//   runtime-config        — {model, contextWindow} (latest wins)
//   user / assistant      — {timestamp, message:{role, model?, content[]}};
//                           content blocks: text/thinking/tool_use
// No usage fields are emitted by qoder, so token/cost stay 0.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { emptyAcc, writeSession, type SessionAcc } from './shared.js';
import type { IngestSource } from './pi.js';

export const QODER_PROJECTS_ROOT = path.join(homedir(), '.qoder', 'projects');

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
    if (!acc) {
      if (!o.sessionId) continue;
      acc = emptyAcc(o.sessionId, 'qoder');
      acc.platform = platform;
    }
    const ts = typeof o.timestamp === 'string' ? o.timestamp : acc.lastActivity;
    acc.lastActivity = ts ?? acc.lastActivity;
    acc.startedAt = acc.startedAt ?? ts;
    if (o.type === 'workspace-directories' && Array.isArray(o.directories) && o.directories.length) {
      acc.cwd = acc.cwd ?? o.directories[0];
    } else if (o.type === 'runtime-config' && o.model) {
      acc.modelId = o.model;
    } else if (o.type === 'assistant') {
      const msg = o.message ?? {};
      acc.modelId = msg.model && msg.model !== '<synthetic>' ? msg.model : acc.modelId;
      acc.turns += 1;
      for (const c of msg.content ?? []) {
        if (c?.type === 'tool_use') {
          acc.toolCalls += 1;
          acc.toolCallRows.push({ name: c.name ?? 'unknown', ts });
        }
      }
      acc.turnRows.push({ role: 'assistant', ts, modelId: acc.modelId, providerId: 'qoder', inputTokens: 0, outputTokens: 0, cost: 0 });
    } else if (o.type === 'user') {
      acc.cwd = o.cwd ?? acc.cwd;
      acc.turns += 1;
      acc.turnRows.push({ role: 'user', ts, inputTokens: 0, outputTokens: 0, cost: 0 });
    }
  }
  return acc;
}

/** Ingest one qoder variant's projects root. agentId is 'qoder' or 'qoder-cn'. */
export function ingestQoderRoot(db: DatabaseSync, projectsRoot: string, agentId: string, platform: string): { files: number; sessions: number } {
  try {
    statSync(projectsRoot);
  } catch {
    return { files: 0, sessions: 0 };
  }
  let files = 0;
  let sessions = 0;
  for (const file of findJsonlFiles(projectsRoot)) {
    files += 1;
    try {
      const acc = parseSessionFile(file, platform);
      if (!acc) continue;
      acc.agentId = agentId;
      if (writeSession(db, acc)) sessions += 1;
    } catch (e) {
      console.error(`failed to ingest ${file}: ${e}`);
    }
  }
  return { files, sessions };
}

export function ingestQoderSessions(db: DatabaseSync, opts: IngestSource = {}): { files: number; sessions: number } {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? 'local';
  return ingestQoderRoot(db, path.join(home, '.qoder', 'projects'), 'qoder', platform);
}

export function ingestQoderCnSessions(db: DatabaseSync, opts: IngestSource = {}): { files: number; sessions: number } {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? 'local';
  return ingestQoderRoot(db, path.join(home, '.qoder-cn', 'projects'), 'qoder-cn', platform);
}

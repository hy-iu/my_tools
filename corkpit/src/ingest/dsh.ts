// dsh session ingester.
// Layout: $DSH_HOME/sessions/<mangled-cwd>/<session-id>/session.jsonl.zstd
// The file is MULTI-FRAME zstd (see zstd.ts). First record is the header
// {type:"session", id, createdAt(ms), cwd}; the rest are events
// {type, seq, time(ms), data}. Relevant events: assistant/message (usage),
// user/message, tool/call, request/context (provider/model truth source).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { zstdDecompressAll } from './zstd.js';
import { emptyAcc, writeSession, epochMsToIso, type SessionAcc } from './shared.js';

export const DSH_SESSIONS_ROOT = path.join(homedir(), '.dsh', 'sessions');

function findZstdFiles(dir: string, depth = 0): string[] {
  const out: string[] = [];
  if (depth > 8) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findZstdFiles(p, depth + 1));
    else if (entry.name.endsWith('.zstd')) out.push(p);
  }
  return out;
}

function parseSessionFile(file: string): SessionAcc | undefined {
  let acc: SessionAcc | undefined;
  let text: string;
  try {
    text = zstdDecompressAll(readFileSync(file)).toString('utf8');
  } catch {
    return undefined;
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = epochMsToIso(o.time);
    if (o.type === 'session') {
      acc = emptyAcc(o.id, 'dsh');
      acc.cwd = o.cwd;
      acc.startedAt = epochMsToIso(o.createdAt);
      acc.lastActivity = acc.startedAt;
    } else if (!acc) {
      continue;
    } else if (o.type === 'assistant/message') {
      const usage = o.data?.usage ?? {};
      acc.lastActivity = ts ?? acc.lastActivity;
      acc.turns += 1;
      acc.inputTokens += usage.inputTokens ?? 0;
      acc.outputTokens += usage.outputTokens ?? 0;
      acc.cacheReadTokens += usage.cacheReadTokens ?? 0;
      acc.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
      acc.reasoningTokens += usage.reasoningTokens ?? 0;
      acc.turnRows.push({
        role: 'assistant', ts, modelId: acc.modelId, providerId: acc.providerId,
        inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, cost: 0,
      });
    } else if (o.type === 'user/message') {
      acc.turns += 1;
      acc.lastActivity = ts ?? acc.lastActivity;
      acc.turnRows.push({ role: 'user', ts, inputTokens: 0, outputTokens: 0, cost: 0 });
    } else if (o.type === 'tool/call') {
      acc.toolCalls += 1;
      acc.toolCallRows.push({ name: o.data?.name ?? 'unknown', ts });
    } else if (o.type === 'request/context') {
      // truth source for provider/model per dsh's own docs
      acc.providerId = o.data?.provider ?? acc.providerId;
      acc.modelId = o.data?.model ?? acc.modelId;
    } else if (o.type === 'request/header') {
      const cfg = o.data?.header?.config;
      if (cfg) {
        acc.providerId = acc.providerId ?? cfg.provider;
        acc.modelId = acc.modelId ?? cfg.model;
      }
    }
  }
  return acc;
}

export function ingestDshSessions(db: DatabaseSync, root: string = DSH_SESSIONS_ROOT): { files: number; sessions: number } {
  try {
    statSync(root);
  } catch {
    return { files: 0, sessions: 0 };
  }
  let files = 0;
  let sessions = 0;
  for (const file of findZstdFiles(root)) {
    files += 1;
    const acc = parseSessionFile(file);
    if (!acc) continue;
    if (writeSession(db, acc)) sessions += 1;
  }
  return { files, sessions };
}

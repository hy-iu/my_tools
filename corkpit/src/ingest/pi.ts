import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { emptyAcc, writeSession, type SessionAcc } from './shared.js';

export const PI_SESSIONS_ROOT = path.join(homedir(), '.pi', 'agent', 'sessions');

export interface IngestSource {
  /** home directory of the platform being ingested (defaults to this process's home) */
  home?: string;
  /** platform id recorded on every session ('local' by default) */
  platform?: string;
}

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
      acc = emptyAcc(o.id, 'pi');
      acc.platform = platform;
      acc.cwd = o.cwd;
      acc.startedAt = o.timestamp;
      acc.lastActivity = o.timestamp;
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

export function ingestPiSessions(db: DatabaseSync, opts: IngestSource = {}): { files: number; sessions: number } {
  const root = opts.home ? path.join(opts.home, '.pi', 'agent', 'sessions') : PI_SESSIONS_ROOT;
  const platform = opts.platform ?? 'local';
  try {
    statSync(root);
  } catch {
    return { files: 0, sessions: 0 };
  }
  let files = 0;
  let sessions = 0;
  for (const file of findJsonlFiles(root)) {
    files += 1;
    try {
      const acc = parseSessionFile(file, platform);
      if (!acc) continue;
      if (writeSession(db, acc)) sessions += 1;
    } catch (e) {
      console.error(`failed to ingest ${file}: ${e}`);
    }
  }
  return { files, sessions };
}

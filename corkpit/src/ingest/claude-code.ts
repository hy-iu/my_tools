// claude-code session ingester.
// Layout: ~/.claude/projects/<mangled-cwd>/<sessionId>.jsonl — one JSON
// object per line. Record types: user / assistant / queue-operation /
// attachment / last-prompt. Assistant records carry message.model and
// message.usage (input_tokens, output_tokens, cache_creation_input_tokens,
// cache_read_input_tokens); tool_use blocks inside message.content include
// MCP calls named `mcp__<server>__<tool>`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { emptyAcc, writeSession, type SessionAcc } from './shared.js';

export const CLAUDE_PROJECTS_ROOT = path.join(homedir(), '.claude', 'projects');

function findJsonlFiles(dir: string, depth = 0): string[] {
  const out: string[] = [];
  if (depth > 8) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findJsonlFiles(p, depth + 1));
    else if (entry.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function parseSessionFile(file: string): SessionAcc | undefined {
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
      // any record carrying a sessionId starts the accumulator
      if (!o.sessionId) continue;
      acc = emptyAcc(o.sessionId, 'claude-code');
      acc.cwd = o.cwd;
    }
    acc.cwd = o.cwd ?? acc.cwd;
    const ts = typeof o.timestamp === 'string' ? o.timestamp : acc.lastActivity;
    acc.lastActivity = ts ?? acc.lastActivity;
    acc.startedAt = acc.startedAt ?? ts;
    if (o.type === 'assistant') {
      const msg = o.message ?? {};
      const usage = msg.usage ?? {};
      acc.modelId = msg.model ?? acc.modelId;
      acc.turns += 1;
      acc.inputTokens += usage.input_tokens ?? 0;
      acc.outputTokens += usage.output_tokens ?? 0;
      acc.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
      acc.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
      acc.turnRows.push({
        role: 'assistant', ts, modelId: msg.model, providerId: undefined,
        inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0, cost: 0,
      });
      for (const c of msg.content ?? []) {
        if (c?.type === 'tool_use') {
          acc.toolCalls += 1;
          acc.toolCallRows.push({ name: c.name ?? 'unknown', ts });
        }
      }
    } else if (o.type === 'user') {
      acc.turns += 1;
      acc.turnRows.push({ role: 'user', ts, inputTokens: 0, outputTokens: 0, cost: 0 });
    }
  }
  return acc;
}

export function ingestClaudeSessions(db: DatabaseSync, root: string = CLAUDE_PROJECTS_ROOT): { files: number; sessions: number } {
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
      const acc = parseSessionFile(file);
      if (!acc) continue;
      if (writeSession(db, acc)) sessions += 1;
    } catch (e) {
      console.error(`failed to ingest ${file}: ${e}`);
    }
  }
  return { files, sessions };
}

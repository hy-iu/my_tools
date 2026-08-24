// Unified ingestion across every adapted application.
import type { DatabaseSync } from 'node:sqlite';
import { ingestPiSessions } from './pi.js';
import { ingestDshSessions } from './dsh.js';
import { ingestClaudeSessions } from './claude-code.js';
import { ingestCodexSessions } from './codex.js';
import { ingestOpencodeSessions } from './opencode.js';

export interface IngestReport {
  files: number;
  sessions: number;
  byAgent: Record<string, { files: number; sessions: number }>;
}

export function ingestAll(db: DatabaseSync): IngestReport {
  const byAgent: IngestReport['byAgent'] = {
    pi: ingestPiSessions(db),
    dsh: ingestDshSessions(db),
    'claude-code': ingestClaudeSessions(db),
    codex: ingestCodexSessions(db),
    opencode: ingestOpencodeSessions(db),
  };
  let files = 0;
  let sessions = 0;
  for (const r of Object.values(byAgent)) {
    files += r.files;
    sessions += r.sessions;
  }
  return { files, sessions, byAgent };
}

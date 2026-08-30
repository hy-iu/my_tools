// Unified ingestion across every adapted application AND every platform.
// Platforms: local host + every WSL distro (read through \\wsl.localhost) +
// manual roots from ~/.cockpit/platforms.json (see src/platforms.ts). Each
// ingester runs once per platform with that platform's home, so e.g. codex
// on the host and codex inside Ubuntu-26.04 land as distinct sessions.
// Fleet peers (MacBook / Ubuntu servers running their own cockpit) are NOT
// merged here — they are aggregated live via /api/fleet instead.
import type { DatabaseSync } from 'node:sqlite';
import { discoverPlatforms, LOCAL_PLATFORM_ID, type Platform } from '../platforms.js';
import { ingestPiSessions } from './pi.js';
import { ingestDshSessions } from './dsh.js';
import { ingestClaudeSessions } from './claude-code.js';
import { ingestCodexSessions } from './codex.js';
import { ingestOpencodeSessions } from './opencode.js';
import { ingestGrokSessions } from './grok.js';
import { ingestQoderSessions, ingestQoderCnSessions } from './qoder.js';
import { ingestZcodeSessions } from './zcode.js';

export interface IngestReport {
  files: number;
  sessions: number;
  byAgent: Record<string, { files: number; sessions: number }>;
}

function add(byAgent: IngestReport['byAgent'], key: string, r: { files: number; sessions: number }): void {
  const cur = byAgent[key] ?? { files: 0, sessions: 0 };
  cur.files += r.files;
  cur.sessions += r.sessions;
  byAgent[key] = cur;
}

/** Run every ingester against one platform's home. One ingester failing must
 *  not discard the platform's other results, so each runs guarded. */
function ingestPlatform(db: DatabaseSync, p: Platform): IngestReport['byAgent'] {
  const src = { home: p.home, platform: p.id };
  const byAgent: IngestReport['byAgent'] = {};
  const run = (key: string, fn: () => { files: number; sessions: number }) => {
    try {
      add(byAgent, key, fn());
    } catch (e) {
      console.error(`ingest ${key} on ${p.id} failed: ${e}`);
    }
  };
  run('pi', () => ingestPiSessions(db, src));
  run('dsh', () => ingestDshSessions(db, src));
  run('claude-code', () => ingestClaudeSessions(db, src));
  run('codex', () => ingestCodexSessions(db, src));
  run('opencode', () => ingestOpencodeSessions(db, src));
  run('grok', () => ingestGrokSessions(db, src));
  run('qoder', () => ingestQoderSessions(db, src));
  run('qoder-cn', () => ingestQoderCnSessions(db, src));
  run('zcode', () => ingestZcodeSessions(db, src));
  return byAgent;
}

export async function ingestAll(db: DatabaseSync): Promise<IngestReport> {
  const platforms = await discoverPlatforms();
  const byAgent: IngestReport['byAgent'] = {};
  let files = 0;
  let sessions = 0;
  for (const p of platforms) {
    if (!p.available) continue;
    try {
      const r = ingestPlatform(db, p);
      for (const [agent, s] of Object.entries(r)) {
        if (p.id !== LOCAL_PLATFORM_ID && s.sessions === 0 && s.files === 0) continue;
        add(byAgent, p.id === LOCAL_PLATFORM_ID ? agent : `${agent}@${p.slug}`, s);
        files += s.files;
        sessions += s.sessions;
      }
    } catch (e) {
      console.error(`ingest failed for platform ${p.id}: ${e}`);
    }
  }
  return { files, sessions, byAgent };
}

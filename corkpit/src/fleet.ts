// Fleet: other machines (MacBook / Ubuntu server) running their own cockpit.
// Config ~/.cockpit/fleet.json: [{ "id": "macbook", "name": "MacBook Pro",
// "url": "http://192.168.1.20:4177" }]. Peers expose a read-only /api/export;
// nothing is merged into the local store, so costs never double-count.
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export interface FleetPeer {
  id: string;
  name: string;
  url: string;
}

export interface FleetStatus extends Partial<ExportSnapshot> {
  id: string;
  name: string;
  url: string;
  online: boolean;
}

export interface ExportSnapshot {
  health: { ok: boolean; active: number; label?: string };
  agents: { agent_id: string; sessions: number; active: number; last_activity: string | null }[];
  totals: { sessions: number; tokens: number; cost: number };
  platforms?: { id: string; label: string; kind: string; available: boolean }[];
}

export function fleetPeers(): FleetPeer[] {
  try {
    const list = JSON.parse(readFileSync(path.join(homedir(), '.cockpit', 'fleet.json'), 'utf8'));
    return Array.isArray(list)
      ? list
          .filter((p: any) => p && p.id && p.url)
          .map((p: any) => ({ id: String(p.id), name: String(p.name ?? p.id), url: String(p.url).replace(/\/$/, '') }))
      : [];
  } catch {
    return [];
  }
}

function fetchJson<T>(url: string, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const req = httpRequest(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data) as T);
        } catch {
          resolve(undefined);
        }
      });
    });
    req.on('error', () => resolve(undefined));
    req.on('timeout', () => req.destroy());
    req.end();
  });
}

export async function probeFleet(timeoutMs = 2500): Promise<FleetStatus[]> {
  return Promise.all(
    fleetPeers().map(async (peer) => {
      const exp = await fetchJson<ExportSnapshot>(`${peer.url}/api/export`, timeoutMs);
      return { ...peer, online: !!exp?.health?.ok, ...(exp ?? {}) };
    })
  );
}

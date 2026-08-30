#!/usr/bin/env node
import { openDb } from './db.js';
import { adapters, getAdapter } from './adapters/index.js';
import { ingestAll } from './ingest/all.js';
import { syncRegistry } from './ingest/registry.js';
import { createServer } from './server.js';
import { runTray } from './tray.js';
import { discoverPlatforms } from './platforms.js';
import { probeFleet } from './fleet.js';

const [command, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

function usage(): void {
  console.log(`cockpit — multi-level agent cockpit

commands:
  serve [--port 4177] [--host 127.0.0.1]
                                 start web UI + API (use --host 0.0.0.0 to be a fleet peer)
  tray [--port 4177]             Windows tray host: background server + status icon,
                                 menu for panel/ingest/dsh update check/dsh web
  ingest                         parse sessions from every platform (host + WSL distros)
                                 into the store, sync registry
  platforms                      list discovered platforms (local / WSL / manual roots)
  fleet                          show fleet peers from ~/.cockpit/fleet.json
  adapters                       print current config of every adapted application
  route --app <id> --provider <id> --model <id>
                                 switch an application's model/provider
  knowledge --title <t> [--body <b>] [--tags <a,b>]
                                 add a knowledge note

apps: ${adapters.map((a) => a.id).join(', ')}`);
}

const db = openDb();

switch (command) {
  case 'tray': {
    const port = Number(flag('port') ?? 4177);
    void ingestAll(db).then(() => syncRegistry(db)).finally(() => {
      db.close();
      void runTray(port);
    });
    break;
  }
  case 'serve': {
    const port = Number(flag('port') ?? 4177);
    const host = flag('host') ?? '127.0.0.1';
    ingestAll(db)
      .then((r) => {
        syncRegistry(db);
        console.log(`ingested ${r.sessions} sessions from ${r.files} files across ${Object.keys(r.byAgent).length} agent/platform sources`);
      })
      .then(() => {
        createServer(db).listen(port, host, () => {
          console.log(`cockpit running at http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port} (bound ${host})`);
        });
      });
    break;
  }
  case 'ingest': {
    void ingestAll(db).then((r) => {
      syncRegistry(db);
      console.log(`ingested ${r.sessions} sessions from ${r.files} files`);
      for (const [agent, s] of Object.entries(r.byAgent)) {
        console.log(`  ${agent.padEnd(24)} ${String(s.sessions).padStart(4)} sessions / ${s.files} files`);
      }
    });
    break;
  }
  case 'platforms': {
    void discoverPlatforms().then((ps) => {
      for (const p of ps) {
        console.log(`${p.id.padEnd(28)} ${p.available ? 'ok' : 'unavailable'}  ${p.home}`);
      }
    });
    break;
  }
  case 'fleet': {
    void (async () => {
      const peers = await probeFleet(3000);
      if (!peers.length) {
        console.log('no fleet peers — add ~/.cockpit/fleet.json:');
        console.log('  [{ "id": "macbook", "name": "MacBook Pro", "url": "http://192.168.1.20:4177" }]');
        console.log('peers run `cockpit serve --host 0.0.0.0` on the other machines.');
        return;
      }
      for (const p of peers) {
        if (!p.online) {
          console.log(`${p.id.padEnd(16)} ${p.url}  OFFLINE`);
          continue;
        }
        const t = p.totals ?? { sessions: 0, tokens: 0, cost: 0 };
        const agents = (p.agents ?? []).map((a) => a.agent_id).join(', ');
        console.log(`${p.id.padEnd(16)} ${p.url}  ${t.sessions} sessions · ${(t.tokens / 1e6).toFixed(1)}M tokens · $${t.cost.toFixed(2)}`);
        console.log(`${''.padEnd(16)} agents: ${agents || '—'}`);
      }
    })();
    break;
  }
  case 'adapters': {
    for (const adapter of adapters) {
      const s = adapter.read();
      const current = s.current ? `${s.current.providerId}/${s.current.modelId}` : 'n/a';
      console.log(`${s.app.padEnd(12)} exists=${s.exists} current=${current} providers=${s.providers.length} models=${s.models.length}${s.error ? ` error=${s.error}` : ''}`);
    }
    break;
  }
  case 'route': {
    const app = flag('app');
    const providerId = flag('provider');
    const modelId = flag('model');
    if (!app || !providerId || !modelId) {
      console.error('route requires --app, --provider, --model');
      process.exit(1);
    }
    const adapter = getAdapter(app);
    if (!adapter?.route) {
      console.error(`no routing support for app: ${app}`);
      process.exit(1);
    }
    const result = adapter.route({ providerId, modelId });
    console.log(result.message);
    if (result.ok) syncRegistry(db);
    process.exit(result.ok ? 0 : 1);
    break;
  }
  case 'knowledge': {
    const title = flag('title');
    if (!title) {
      console.error('knowledge requires --title');
      process.exit(1);
    }
    const r = db.prepare(`INSERT INTO knowledge_notes (title, body, tags) VALUES (?, ?, ?)`)
      .run(title, flag('body') ?? '', flag('tags') ?? '');
    console.log(`added knowledge note #${r.lastInsertRowid}`);
    break;
  }
  default:
    usage();
}

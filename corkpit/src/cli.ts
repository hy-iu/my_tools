#!/usr/bin/env node
import { openDb } from './db.js';
import { adapters, getAdapter } from './adapters/index.js';
import { ingestAll } from './ingest/all.js';
import { syncRegistry } from './ingest/registry.js';
import { createServer } from './server.js';
import { runTray } from './tray.js';

const [command, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

function usage(): void {
  console.log(`cockpit — multi-level agent cockpit

commands:
  serve [--port 4177]            start local web UI + API
  tray [--port 4177]             Windows tray host: background server + status icon,
                                 menu for panel/ingest/dsh update check/dsh web
  ingest                         parse pi/dsh/claude/codex/opencode sessions into the store, sync registry
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
    ingestAll(db);
    syncRegistry(db);
    db.close();
    void runTray(port);
    break;
  }
  case 'serve': {
    const port = Number(flag('port') ?? 4177);
    ingestAll(db);
    syncRegistry(db);
    createServer(db).listen(port, '127.0.0.1', () => {
      console.log(`cockpit running at http://127.0.0.1:${port}`);
    });
    break;
  }
  case 'ingest': {
    const r = ingestAll(db);
    syncRegistry(db);
    console.log(`ingested ${r.sessions} sessions from ${r.files} files`);
    for (const [agent, s] of Object.entries(r.byAgent)) {
      console.log(`  ${agent.padEnd(12)} ${String(s.sessions).padStart(4)} sessions / ${s.files} files`);
    }
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

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseDocument } from 'yaml';
import type { Adapter, AdapterSnapshot } from './types.js';
import { backupFile } from './util.js';

const CONFIG = path.join(homedir(), '.dsh', 'settings.yaml');

function loadDoc() {
  return parseDocument(readFileSync(CONFIG, 'utf8'));
}

export const dshAdapter: Adapter = {
  id: 'dsh',
  displayName: 'dsh',
  read(): AdapterSnapshot {
    const snapshot: AdapterSnapshot = {
      app: 'dsh',
      displayName: 'dsh',
      configPaths: [CONFIG],
      exists: existsSync(CONFIG),
      providers: [],
      models: [],
      routeSupported: true,
    };
    if (!snapshot.exists) return snapshot;
    try {
      const doc = loadDoc();
      const data = doc.toJS() ?? {};
      const def = data['agent-default-model'] ?? {};
      snapshot.current = { providerId: def.provider, modelId: def.model };
      const providers = data?.['llm-pi-ai']?.providers ?? {};
      for (const [id, p] of Object.entries<any>(providers)) {
        snapshot.providers.push({
          id,
          displayName: p?.name ?? id,
          baseUrl: p?.baseUrl,
          keySource: p?.apiKeyEnv ? `env:${p.apiKeyEnv}` : p?.apiKey ? 'inline' : 'none',
        });
        for (const m of p?.models ?? []) {
          snapshot.models.push({
            id: m.id,
            providerId: id,
            displayName: m.name ?? m.id,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
          });
        }
      }
    } catch (e) {
      snapshot.error = String(e);
    }
    return snapshot;
  },
  route({ providerId, modelId }) {
    backupFile(CONFIG);
    const doc = loadDoc();
    doc.setIn(['agent-default-model', 'provider'], providerId);
    doc.setIn(['agent-default-model', 'model'], modelId);
    writeFileSync(CONFIG, doc.toString());
    return { ok: true, message: `dsh → ${providerId}/${modelId}` };
  },
};

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import type { Adapter, AdapterSnapshot } from './types.js';
import { backupFile, readJsonSafe, replaceTopLevelToml } from './util.js';

const CONFIG = path.join(homedir(), '.codex', 'config.toml');
const CATALOG = path.join(homedir(), '.codex', 'model-catalog.local.json');

export const codexAdapter: Adapter = {
  id: 'codex',
  displayName: 'Codex',
  read(): AdapterSnapshot {
    const snapshot: AdapterSnapshot = {
      app: 'codex',
      displayName: 'Codex',
      configPaths: [CONFIG, CATALOG],
      exists: existsSync(CONFIG),
      providers: [],
      models: [],
      routeSupported: true,
    };
    if (!snapshot.exists) return snapshot;
    try {
      const toml = parse(readFileSync(CONFIG, 'utf8')) as Record<string, any>;
      snapshot.current = {
        providerId: toml.model_provider,
        modelId: toml.model,
      };
      const providers = (toml.model_providers ?? {}) as Record<string, any>;
      for (const [id, p] of Object.entries(providers)) {
        snapshot.providers.push({
          id,
          displayName: p.name ?? id,
          baseUrl: p.base_url,
          keySource: p.env_key ? `env:${p.env_key}` : 'none',
        });
      }
      const catalog = readJsonSafe(CATALOG);
      for (const m of catalog?.models ?? []) {
        snapshot.models.push({
          id: m.slug,
          providerId: '',
          displayName: m.display_name ?? m.slug,
          contextWindow: m.context_window,
          reasoning: (m.supported_reasoning_levels ?? []).length > 0,
        });
      }
    } catch (e) {
      snapshot.error = String(e);
    }
    return snapshot;
  },
  route({ providerId, modelId }) {
    const backup = backupFile(CONFIG);
    let content = readFileSync(CONFIG, 'utf8');
    content = replaceTopLevelToml(content, 'model_provider', providerId);
    content = replaceTopLevelToml(content, 'model', modelId);
    writeFileSync(CONFIG, content);
    return { ok: true, message: `codex → ${providerId}/${modelId}${backup ? ` (backup: ${path.basename(backup)})` : ''}` };
  },
};

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Adapter, AdapterSnapshot } from './types.js';
import { backupFile, readJsonSafe, writeJson } from './util.js';

const SETTINGS = path.join(homedir(), '.pi', 'agent', 'settings.json');
const MODELS = path.join(homedir(), '.pi', 'agent', 'models.json');

export const piAdapter: Adapter = {
  id: 'pi',
  displayName: 'pi',
  read(): AdapterSnapshot {
    const snapshot: AdapterSnapshot = {
      app: 'pi',
      displayName: 'pi',
      configPaths: [SETTINGS, MODELS],
      exists: existsSync(SETTINGS),
      providers: [],
      models: [],
      routeSupported: true,
    };
    if (!snapshot.exists) return snapshot;
    try {
      const settings = readJsonSafe(SETTINGS) ?? {};
      snapshot.current = {
        providerId: settings.defaultProvider,
        modelId: settings.defaultModel,
      };
      const store = readJsonSafe(MODELS) ?? {};
      for (const [id, p] of Object.entries<any>(store.providers ?? {})) {
        snapshot.providers.push({
          id,
          displayName: p.name ?? id,
          baseUrl: p.baseUrl,
          keySource: p.apiKey ? 'inline (models.json)' : p.apiKeyEnv ? `env:${p.apiKeyEnv}` : 'none',
        });
        for (const m of p.models ?? []) {
          snapshot.models.push({
            id: m.id,
            providerId: id,
            displayName: m.name ?? m.id,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
            reasoning: m.reasoning,
          });
        }
      }
    } catch (e) {
      snapshot.error = String(e);
    }
    return snapshot;
  },
  route({ providerId, modelId }) {
    const settings = readJsonSafe(SETTINGS) ?? {};
    backupFile(SETTINGS);
    settings.defaultProvider = providerId;
    settings.defaultModel = modelId;
    writeJson(SETTINGS, settings);
    return { ok: true, message: `pi → ${providerId}/${modelId}` };
  },
};

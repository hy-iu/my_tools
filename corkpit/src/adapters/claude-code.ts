import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Adapter, AdapterSnapshot } from './types.js';
import { backupFile, readJsonSafe, writeJson } from './util.js';

const CONFIG = path.join(homedir(), '.claude', 'settings.json');

export const claudeCodeAdapter: Adapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  read(): AdapterSnapshot {
    const snapshot: AdapterSnapshot = {
      app: 'claude-code',
      displayName: 'Claude Code',
      configPaths: [CONFIG],
      exists: existsSync(CONFIG),
      providers: [],
      models: [],
      routeSupported: true,
    };
    if (!snapshot.exists) return snapshot;
    try {
      const settings = readJsonSafe(CONFIG) ?? {};
      const env = settings.env ?? {};
      const baseUrl = env.ANTHROPIC_BASE_URL;
      let providerId = 'anthropic';
      try {
        if (baseUrl) providerId = new URL(baseUrl).hostname;
      } catch {
        providerId = baseUrl;
      }
      snapshot.current = {
        providerId,
        modelId: env.ANTHROPIC_MODEL,
        baseUrl,
      };
      snapshot.providers.push({
        id: providerId,
        displayName: baseUrl ?? 'Anthropic',
        baseUrl,
        keySource: env.ANTHROPIC_AUTH_TOKEN ? 'inline (settings.json env)' : env.ANTHROPIC_API_KEY ? 'env:ANTHROPIC_API_KEY' : 'none',
      });
      for (const key of Object.keys(env)) {
        const m = /^ANTHROPIC_DEFAULT_(\w+)_MODEL$/.exec(key);
        if (m) {
          snapshot.models.push({
            id: env[key],
            providerId,
            displayName: `${m[1].toLowerCase()}: ${env[key]}`,
          });
        }
      }
      if (env.ANTHROPIC_MODEL) {
        snapshot.models.unshift({ id: env.ANTHROPIC_MODEL, providerId, displayName: `main: ${env.ANTHROPIC_MODEL}` });
      }
    } catch (e) {
      snapshot.error = String(e);
    }
    return snapshot;
  },
  route({ modelId }) {
    const settings = readJsonSafe(CONFIG) ?? {};
    backupFile(CONFIG);
    settings.env = settings.env ?? {};
    settings.env.ANTHROPIC_MODEL = modelId;
    writeJson(CONFIG, settings);
    return { ok: true, message: `claude-code → ${modelId}` };
  },
};

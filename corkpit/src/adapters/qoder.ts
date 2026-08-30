// qoder / qoder-cn adapters. Qoder routes through its own subscription
// backend, so the provider is synthetic ("qoder"); what IS switchable is the
// active model in ~/.qoder/settings.json (`model.name`) — e.g.
// "deepseek/deepseek-v4-flash-pg" or "bailian/qwen3.8-max-tp". Route rewrites
// that one field after a timestamped backup; nothing else is touched.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Adapter, AdapterSnapshot, RouteOptions, RouteResult } from './types.js';
import { backupFile, readJsonSafe, writeJson } from './util.js';

export function makeQoderAdapter(variant: 'qoder' | 'qoder-cn'): Adapter {
  const home = path.join(homedir(), variant === 'qoder' ? '.qoder' : '.qoder-cn');
  const settings = path.join(home, 'settings.json');
  const displayName = variant === 'qoder' ? 'Qoder' : 'Qoder CN';

  return {
    id: variant,
    displayName,
    read(): AdapterSnapshot {
      const snapshot: AdapterSnapshot = {
        app: variant,
        displayName,
        configPaths: [settings, path.join(home, 'mcp.json')],
        exists: existsSync(settings),
        providers: [],
        models: [],
        routeSupported: true,
      };
      if (!snapshot.exists) return snapshot;
      const cfg = readJsonSafe(settings);
      if (!cfg) {
        snapshot.error = 'settings.json unreadable';
        return snapshot;
      }
      const currentModel = cfg?.model?.name;
      if (currentModel) snapshot.current = { providerId: variant, modelId: currentModel };
      // candidate models: everything the user has tuned preferences for,
      // plus the active model.
      const seen = new Set<string>();
      for (const id of [currentModel, ...Object.keys(cfg?.model?.preferences ?? {})]) {
        if (id && !seen.has(id)) {
          seen.add(id);
          const pref = cfg?.model?.preferences?.[id] ?? {};
          snapshot.models.push({
            id,
            providerId: variant,
            displayName: id,
            contextWindow: pref.contextWindow,
            reasoning: !!pref.reasoning?.enabled,
          });
        }
      }
      snapshot.providers = [{ id: variant, displayName: `${displayName} (subscription)`, keySource: 'none' }];
      return snapshot;
    },
    route({ modelId }: RouteOptions): RouteResult {
      const cfg = readJsonSafe(settings);
      if (!cfg) return { ok: false, message: `${variant}: settings.json unreadable` };
      const backup = backupFile(settings);
      cfg.model = cfg.model ?? {};
      cfg.model.name = modelId;
      try {
        writeJson(settings, cfg);
      } catch (e) {
        return { ok: false, message: `${variant}: write failed: ${e}` };
      }
      return { ok: true, message: `${variant} → ${modelId}${backup ? ` (backup: ${path.basename(backup)})` : ''}` };
    },
  };
}

export const qoderAdapter = makeQoderAdapter('qoder');
export const qoderCnAdapter = makeQoderAdapter('qoder-cn');

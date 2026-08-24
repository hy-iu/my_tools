// Read-only view into cc-switch (the provider-switcher for Claude Code / Codex
// / opencode / gemini / pi). This adapter NEVER writes: switching is done by
// cc-switch itself, so cockpit only observes its catalog + current selection.
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Adapter, AdapterSnapshot } from './types.js';

const HOME = homedir();
const CC_DIR = path.join(HOME, '.cc-switch');
const SETTINGS = path.join(CC_DIR, 'settings.json');
const DB = path.join(CC_DIR, 'cc-switch.db');

function readSettings(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(SETTINGS, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

// best-effort base_url extraction from a provider's settings_config, which is a
// JSON string for claude/opencode/pi and a TOML string for codex/gemini.
function extractBaseUrl(settingsConfig: string): string | undefined {
  try {
    const j = JSON.parse(settingsConfig);
    return j?.env?.ANTHROPIC_BASE_URL ?? j?.provider?.vendor?.baseURL ?? j?.base_url ?? undefined;
  } catch {
    /* not JSON — try raw regex over toml/json */
  }
  const m = /["']?(?:base_url|baseURL|url)["']?\s*[:=]\s*["']([^"']+)["']/.exec(settingsConfig);
  return m?.[1];
}

function hasKey(settingsConfig: string): string | undefined {
  if (/ANTHROPIC_(AUTH_TOKEN|API_KEY)\s*[:=]/.test(settingsConfig) || /sk-[A-Za-z0-9]/.test(settingsConfig)) return 'inline';
  if (/env_key|api_key|OPENAI_API_KEY\s*[:=]/.test(settingsConfig)) return 'inline';
  return 'none';
}

export const ccSwitchAdapter: Adapter = {
  id: 'cc-switch',
  displayName: 'cc-switch',
  read(): AdapterSnapshot {
    const snapshot: AdapterSnapshot = {
      app: 'cc-switch',
      displayName: 'cc-switch',
      configPaths: [SETTINGS, DB],
      exists: existsSync(CC_DIR),
      providers: [],
      models: [],
      routeSupported: false, // read-only: never touch cc-switch's own config
    };
    if (!snapshot.exists) return snapshot;
    try {
      const settings = readSettings();
      const curClaude = settings.currentProviderClaude;
      const curCodex = settings.currentProviderCodex;
      snapshot.current = {
        providerId: curCodex === 'default' ? 'default' : (curCodex ?? curClaude),
        modelId: '(see target config)',
      };
      if (existsSync(DB)) {
        const db = new DatabaseSync(DB, { readOnly: true });
        try {
          const rows = db.prepare(`SELECT id, app_type, name, settings_config, is_current FROM providers ORDER BY app_type, name`).all() as any[];
          for (const r of rows) {
            snapshot.providers.push({
              id: r.id,
              displayName: r.name + (r.is_current ? ' · current' : '') +
                (r.app_type === 'claude' || r.app_type === 'codex' ? ` (${r.app_type})` : ''),
              baseUrl: extractBaseUrl(r.settings_config ?? ''),
              keySource: hasKey(r.settings_config ?? ''),
            });
          }
        } finally {
          db.close();
        }
      }
    } catch (e) {
      snapshot.error = String(e);
    }
    return snapshot;
  },
};

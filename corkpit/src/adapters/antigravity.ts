// Antigravity (Google) model config adapter.
//
// The CLI (`agy`) / desktop app route through Google-account auth (and burn the
// AI Pro/Ultra subscription quota). The only per-session knob cockpit can drive
// without touching credentials is the persistent `model` field that `agy`
// stores in `~/.gemini/antigravity-cli/settings.json`. That file is read on
// CLI start and can also be flipped inside a session via `/config`.
//
// NOTE: `agy models` (and the catalog below) name models by display string,
// e.g. "Gemini 3.5 Flash (High)" — not a `provider/model` pair. To fit the
// Adapter contract we bucket each model under the family it belongs to
// (gemini / claude / gpt-oss), while read() always reports the exact persisted
// `model` value so routing stays faithful.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Adapter, AdapterSnapshot } from './types.js';
import { backupFile, readJsonSafe, writeJson } from './util.js';

const HOME = homedir();

// Snapshot of `agy models` (availability shifts between releases, so this is a
// picker convenience; read() still reports whatever `model` is actually saved).
const MODELS: { provider: string; id: string }[] = [
  { provider: 'gemini', id: 'Gemini 3.5 Flash (Low)' },
  { provider: 'gemini', id: 'Gemini 3.5 Flash (Medium)' },
  { provider: 'gemini', id: 'Gemini 3.5 Flash (High)' },
  { provider: 'gemini', id: 'Gemini 3.1 Pro (Low)' },
  { provider: 'gemini', id: 'Gemini 3.1 Pro (High)' },
  { provider: 'claude', id: 'Claude Sonnet 4.6 (Thinking)' },
  { provider: 'claude', id: 'Claude Opus 4.6 (Thinking)' },
  { provider: 'gpt-oss', id: 'GPT-OSS 120B (Medium)' },
];
const PROVIDERS = [...new Set(MODELS.map((m) => m.provider))];

// Current CLI persists the model under `~/.gemini/antigravity-cli/settings.json`;
// earlier builds kept a config under the `~/.antigravity/` root, so fall back
// to that too. The adapter stays read-only on auth/credentials.
const CANDIDATES = [
  path.join(HOME, '.gemini', 'antigravity-cli', 'settings.json'),
  path.join(HOME, '.antigravity', 'settings.json'),
];

function whichConfig(): string | undefined {
  return CANDIDATES.find((f) => existsSync(f));
}

export const antigravityAdapter: Adapter = {
  id: 'antigravity',
  displayName: 'antigravity',
  read(): AdapterSnapshot {
    const file = whichConfig();
    const snapshot: AdapterSnapshot = {
      app: 'antigravity',
      displayName: 'antigravity',
      configPaths: CANDIDATES.filter((f) => existsSync(f)),
      exists: !!file,
      providers: PROVIDERS.map((id) => ({ id, displayName: id })),
      models: MODELS.map((m) => ({ id: m.id, providerId: m.provider, displayName: m.id })),
      routeSupported: true,
    };
    if (!file) return snapshot;
    const data = readJsonSafe(file);
    const current = typeof data?.model === 'string' ? data.model : undefined;
    if (current) {
      const found = MODELS.find((m) => m.id === current);
      snapshot.current = found
        ? { providerId: found.provider, modelId: found.id }
        : { modelId: current }; // persisted value not in catalog — surface as-is
    }
    return snapshot;
  },
  route({ providerId, modelId }) {
    // `model` holds the exact display name (e.g. "Gemini 3.5 Flash (High)").
    const file = whichConfig();
    if (!file) return { ok: false, message: 'no antigravity settings found' };
    backupFile(file);
    const data = readJsonSafe(file) ?? {};
    data.model = modelId || providerId;
    writeJson(file, data);
    return { ok: true, message: `antigravity → ${modelId || providerId}` };
  },
};

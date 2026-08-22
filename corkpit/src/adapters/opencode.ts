import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Adapter, AdapterSnapshot } from './types.js';
import { backupFile, readJsonSafe, writeJson } from './util.js';

const DIR = path.join(homedir(), '.config', 'opencode');
const CONFIG = path.join(DIR, 'opencode.json');
const CONFIG_C = path.join(DIR, 'opencode.jsonc');

function stripJsonc(raw: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inLine) {
      if (ch === '\n') { inLine = false; out += ch; }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i++; }
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && next === '/') { inLine = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
    out += ch;
  }
  return out;
}

function parseJsonc(filePath: string): any {
  return JSON.parse(stripJsonc(readFileSync(filePath, 'utf8')));
}

function loadConfig(): { data: any; file: string } | undefined {
  const jsonData = existsSync(CONFIG) ? readJsonSafe(CONFIG) : undefined;
  let jsoncData: any;
  try {
    if (existsSync(CONFIG_C)) jsoncData = parseJsonc(CONFIG_C);
  } catch {
    jsoncData = undefined;
  }
  if (!jsonData && !jsoncData) return undefined;
  const data = { ...jsonData, ...jsoncData };
  // write to whichever file carries the real content
  const file = jsoncData && (jsoncData.provider || jsoncData.agent) ? CONFIG_C : CONFIG;
  return { data, file };
}

export const opencodeAdapter: Adapter = {
  id: 'opencode',
  displayName: 'opencode',
  read(): AdapterSnapshot {
    const snapshot: AdapterSnapshot = {
      app: 'opencode',
      displayName: 'opencode',
      configPaths: [CONFIG, CONFIG_C],
      exists: existsSync(CONFIG) || existsSync(CONFIG_C),
      providers: [],
      models: [],
      routeSupported: true,
    };
    if (!snapshot.exists) return snapshot;
    try {
      const { data } = loadConfig() ?? { data: {}, file: CONFIG };
      const buildModel: string | undefined = data?.agent?.build?.model;
      if (buildModel) {
        const [providerId, ...rest] = buildModel.split('/');
        snapshot.current = { providerId, modelId: rest.join('/') };
      }
      for (const [id, p] of Object.entries<any>(data?.provider ?? {})) {
        const apiKey: string | undefined = p?.options?.apiKey;
        const envMatch = apiKey ? /^\{env:(.+)\}$/.exec(apiKey) : null;
        snapshot.providers.push({
          id,
          displayName: p?.name ?? id,
          baseUrl: p?.options?.baseURL,
          keySource: envMatch ? `env:${envMatch[1]}` : apiKey ? 'inline' : 'none',
        });
        for (const [mid, m] of Object.entries<any>(p?.models ?? {})) {
          snapshot.models.push({ id: mid, providerId: id, displayName: m?.name ?? mid });
        }
      }
    } catch (e) {
      snapshot.error = String(e);
    }
    return snapshot;
  },
  route({ providerId, modelId }) {
    const loaded = loadConfig();
    if (!loaded) return { ok: false, message: 'no opencode config found' };
    backupFile(loaded.file);
    loaded.data.agent = loaded.data.agent ?? {};
    loaded.data.agent.build = loaded.data.agent.build ?? {};
    loaded.data.agent.build.model = `${providerId}/${modelId}`;
    writeJson(loaded.file, loaded.data);
    return { ok: true, message: `opencode → ${providerId}/${modelId}` };
  },
};

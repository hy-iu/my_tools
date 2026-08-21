import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import type {
  ModelDirectory,
  PresetSummary,
  SkillSummary,
} from "../contract/types";

/**
 * Read-only readers over the DSH data home. Two hard rules:
 *  - never read `.credentials.yaml` (API keys live there, referenced only by
 *    `apiKeyEnv` in the model directory);
 *  - every "directory absent" case degrades to an empty list, never throws.
 */

const NEVER_READ = new Set([".credentials.yaml", "credentials.yaml"]);

/** Parse `~/.dsh/settings.yaml` into the provider/model directory. */
export function readModelDirectory(dshHome: string): ModelDirectory {
  const result: ModelDirectory = { providers: [] };
  const file = path.join(dshHome, "settings.yaml");
  if (!fs.existsSync(file)) return result;

  let doc: unknown;
  try {
    doc = yaml.load(fs.readFileSync(file, "utf8"));
  } catch {
    return result;
  }
  if (typeof doc !== "object" || doc === null) return result;

  const root = doc as Record<string, unknown>;
  const llm = root["llm-pi-ai"] as Record<string, unknown> | undefined;
  const providersMap = llm?.providers as Record<string, unknown> | undefined;

  if (providersMap && typeof providersMap === "object") {
    for (const [id, raw] of Object.entries(providersMap)) {
      const p = raw as Record<string, unknown>;
      const modelsRaw = Array.isArray(p?.models) ? (p.models as Record<string, unknown>[]) : [];
      const models = modelsRaw
        .map((m) => ({
          id: m.id as string,
          name: m.name as string | undefined,
          contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : undefined,
          maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : undefined,
        }))
        .filter((m) => typeof m.id === "string" && m.id.length > 0);
      result.providers.push({
        id,
        name: typeof p?.displayName === "string" ? (p.displayName as string) : undefined,
        models,
      });
    }
  }

  const def = root["agent-default-model"] as Record<string, unknown> | undefined;
  if (def) {
    result.defaultProvider = typeof def.provider === "string" ? def.provider : undefined;
    result.defaultModel = typeof def.model === "string" ? def.model : undefined;
  }
  return result;
}

/**
 * Enumerate agent presets: shipped presets under `<dshInstall>/config/agent-presets`
 * first, then user presets under `<dshHome>/.agent-presets`. Shipped shadows a
 * user directory claiming the same id (roster contract).
 */
export function readPresets(dshHome: string, dshInstallDir?: string): PresetSummary[] {
  const roots: { dir: string; trust: "system" | "user" }[] = [];
  if (dshInstallDir) {
    roots.push({ dir: path.join(dshInstallDir, "config", "agent-presets"), trust: "system" });
  }
  roots.push({ dir: path.join(dshHome, ".agent-presets"), trust: "user" });

  const byId = new Map<string, PresetSummary>();
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue; // root absent — that is normal for a fresh user root
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) continue; // never a usable preset id
      if (byId.has(id)) continue; // earlier root wins
      byId.set(id, readOnePreset(id, root.trust, path.join(root.dir, id)));
    }
  }

  return [...byId.values()].sort(
    (a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id),
  );
}

function readOnePreset(id: string, trust: "system" | "user", dir: string): PresetSummary {
  if (!fs.existsSync(path.join(dir, "agent.cordis.yml"))) {
    return { id, trust, path: dir, broken: "缺少 agent.cordis.yml" };
  }
  const summary: PresetSummary = { id, trust, path: dir };
  const metaFile = path.join(dir, "preset.yml");
  if (fs.existsSync(metaFile)) {
    try {
      const meta = yaml.load(fs.readFileSync(metaFile, "utf8"));
      if (typeof meta === "object" && meta !== null) {
        const m = meta as Record<string, unknown>;
        summary.name = typeof m.name === "string" ? m.name : undefined;
        summary.description = typeof m.description === "string" ? m.description : undefined;
        summary.order = typeof m.order === "number" ? m.order : undefined;
      }
    } catch {
      // Read failure degrades to no metadata (roster behavior).
    }
  }
  return summary;
}

/** Enumerate the user skills root (`<dshHome>/skills`). Absent root → []. */
export function readSkills(dshHome: string): SkillSummary[] {
  const root = path.join(dshHome, "skills");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .map((e) => ({
      id: e.name,
      kind: e.isDirectory() ? ("dir" as const) : ("file" as const),
      path: path.join(root, e.name),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
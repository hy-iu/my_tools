// Shared, dependency-free types used by extension-host readers and (later)
// self-drawn webviews. Keep this module importable from both `host/` and
// `webview-app/` without pulling in `vscode` or Node builtins.

export interface ModelSummary {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface ProviderSummary {
  id: string;
  /** The provider `displayName`, when present (e.g. "Paratera"). */
  name?: string;
  models: ModelSummary[];
}

export interface ModelDirectory {
  providers: ProviderSummary[];
  defaultProvider?: string;
  defaultModel?: string;
}

export type PresetTrust = "system" | "user";

export interface PresetSummary {
  id: string;
  trust: PresetTrust;
  path: string;
  name?: string;
  description?: string;
  order?: number;
  /** Present when the preset directory exists but is not loadable. */
  broken?: string;
}

export interface SkillSummary {
  id: string;
  kind: "dir" | "file";
  path: string;
}
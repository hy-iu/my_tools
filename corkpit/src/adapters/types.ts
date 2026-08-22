export interface ProviderInfo {
  id: string;
  displayName: string;
  baseUrl?: string;
  keySource?: string; // "env:<NAME>" | "inline" | "none"
}

export interface ModelInfo {
  id: string;
  providerId: string;
  displayName?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

export interface AdapterSnapshot {
  app: string;
  displayName: string;
  configPaths: string[];
  exists: boolean;
  current?: { providerId?: string; modelId?: string; baseUrl?: string };
  providers: ProviderInfo[];
  models: ModelInfo[];
  routeSupported: boolean;
  error?: string;
}

export interface RouteOptions {
  providerId: string;
  modelId: string;
}

export interface RouteResult {
  ok: boolean;
  message: string;
}

export interface Adapter {
  id: string;
  displayName: string;
  read(): AdapterSnapshot;
  route?(opts: RouteOptions): RouteResult;
}

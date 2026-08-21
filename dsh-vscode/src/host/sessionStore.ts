import type { HistoryWindow, PresetListResult, SessionSummary } from "../contract/session";
import { apiCall } from "./dshApi";

/**
 * Read-only session store backed by the native `/api` methods. `baseUrl` is the
 * DSH Web origin (`dsh.webUrl`, default `http://127.0.0.1:3080`).
 */
export class SessionStore {
  constructor(private readonly baseUrl: string) {}

  listSessions(): Promise<SessionSummary[]> {
    return apiCall<{ items: SessionSummary[] }>(this.baseUrl, "session.list", {}).then((r) => r.items);
  }

  readHistory(sessionId: string, opts: { beforeSeq?: number; maxMessages?: number } = {}): Promise<HistoryWindow> {
    return apiCall<HistoryWindow>(this.baseUrl, "session.history", { sessionId, ...opts });
  }

  listPresets(): Promise<PresetListResult> {
    return apiCall<PresetListResult>(this.baseUrl, "agentPreset.list", {});
  }
}
// Session-domain wire types returned by the native `/api` read-only methods
// (`session.list`, `session.history`). Mirrors the shapes observed live; kept
// deliberately small — only the fields P2 renderers consume.

export interface SessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  parentSessionId?: string;
  origin?: "subagent";
  cwd?: string;
  agentPreset?: string;
  projections?: {
    asOfSeq: number;
    values: Record<string, unknown>;
  };
}

/** One trajectory event; `type` is the DSH event name (e.g. "tool/call"). */
export interface SessionEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
}

export interface HistoryEntry {
  event: SessionEvent;
  view?: unknown;
}

export interface HistoryWindow {
  events: HistoryEntry[];
  hasMore: boolean;
  projections?: {
    asOfSeq: number;
    values: Record<string, unknown>;
  };
}

export interface PresetListResult {
  authorable: boolean;
  hasDocument: boolean;
  presets: unknown[];
}
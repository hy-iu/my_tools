import type { SessionEvent, SessionSummary } from "../contract/session";

/**
 * Pure trajectory reducer: sessions → a render-ready model. No VSCode imports,
 * so it tests against real `/api` history from a plain Node script. The model
 * feeds the self-drawn webview's timeline (trace), scatter-line (latency),
 * comfy lanes (lanes), attribution graph (toolCalls→files), and transcript
 * (messages).
 */

export interface TracePoint {
  seq: number;
  time: number;
  type: string;
  turn: number;
  step: number;
}

export interface StepLane {
  turn: number;
  step: number;
  start: number;
  end: number;
  durMs: number;
  tools: string[];
}

export interface ToolCall {
  callId: string;
  name: string;
  seq: number;
  resultSeq?: number;
  turn: number;
  step: number;
  argsPreview: string;
  files: string[];
}

export interface MessagePart {
  role: string;
  type: string;
  text: string;
}

export interface LatencyPoint {
  time: number;
  durMs: number;
  step: number;
  turn: number;
}

export interface TokenRow {
  turns: number;
  steps: number;
  llmMs: number;
  toolMs: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface TrajectoryModel {
  sessionId: string;
  title: string;
  turns: number;
  steps: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  trace: TracePoint[];
  lanes: StepLane[];
  toolCalls: ToolCall[];
  files: string[];
  tokenRow: TokenRow;
  latency: LatencyPoint[];
  messages: MessagePart[];
}

const PATH_EXT =
  /[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|md|mdx|py|sh|zsh|bash|go|rs|java|kt|c|cpp|h|hpp|toml|lock|css|scss|html|vue|svelte|txt|log|sql|rb|php|swift|proto|nix|fish|pl|r|jl|ex|exs|dart|ml|mli|cs|fs|fsx|xml|graphql|prisma|mod|env|conf|ini)\b/g;

export function buildTrajectory(sessionId: string, events: SessionEvent[], meta?: SessionSummary): TrajectoryModel {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);

  const trace: TracePoint[] = [];
  const lanes: StepLane[] = [];
  const toolCalls: ToolCall[] = [];
  const messages: MessagePart[] = [];
  const resultSeqByCallId = new Map<string, number>();
  const laneByKey = new Map<string, StepLane>();

  let turns = 0;
  let startTime = ordered.length ? ordered[0].time : 0;
  let endTime = startTime;

  for (const ev of ordered) {
    trace.push({
      seq: ev.seq,
      time: ev.time,
      type: ev.type,
      turn: num(ev.data.turn),
      step: num(ev.data.step),
    });
    endTime = Math.max(endTime, ev.time);

    const turn = num(ev.data.turn);

    if (ev.type === "tool/result") {
      const callId = (ev.data.message as { source?: { callId?: string } } | undefined)?.source?.callId;
      if (callId) resultSeqByCallId.set(callId, ev.seq);
    }

    if (ev.type === "tool/call") {
      const callId = String(ev.data.callId ?? "");
      const name = String(ev.data.name ?? "?");
      const args = String(ev.data.arguments ?? "");
      const files = extractFiles(args);
      toolCalls.push({
        callId,
        name,
        seq: ev.seq,
        turn,
        step: num(ev.data.step),
        argsPreview: args.length > 240 ? args.slice(0, 240) + "…" : args,
        files,
      });
    }

    if (ev.type === "step/start") {
      const key = `${turn}:${num(ev.data.step)}`;
      laneByKey.set(key, {
        turn,
        step: num(ev.data.step),
        start: ev.time,
        end: ev.time,
        durMs: 0,
        tools: [],
      });
    }
    if (ev.type === "step/end") {
      const key = `${turn}:${num(ev.data.step)}`;
      const lane = laneByKey.get(key);
      if (lane) {
        lane.end = ev.time;
        lane.durMs = Math.max(0, ev.time - lane.start);
      }
    }

    if (ev.type === "turn/end") turns = Math.max(turns, turn);

    if (ev.type === "assistant/message" || ev.type === "user/message") {
      const message = ev.data.message as { role?: string; content?: unknown } | undefined;
      const role = message?.role ?? (ev.type.startsWith("user") ? "user" : "assistant");
      const content = message?.content ?? ev.data.content;
      const text = foldContentText(content, role);
      if (text.trim()) {
        const kind = role === "user" ? "prompt" : "reply";
        messages.push({ role, type: kind, text });
      }
    }
  }

  // Attribute tool calls to their step lane.
  for (const tool of toolCalls) {
    tool.resultSeq = resultSeqByCallId.get(tool.callId);
    const lane = laneByKey.get(`${tool.turn}:${tool.step}`);
    if (lane) lane.tools.push(tool.name);
  }

  const sortedLanes = [...laneByKey.values()]
    .filter((l) => l.end >= l.start)
    .sort((a, b) => a.turn - b.turn || a.step - b.step);

  const files = [...new Set(toolCalls.flatMap((t) => t.files))].sort();
  const latency: LatencyPoint[] = sortedLanes.map((l) => ({
    time: l.start,
    durMs: l.durMs,
    step: l.step,
    turn: l.turn,
  }));

  const stats = (meta?.projections?.values?.["sessionStats"] as Record<string, unknown>) ?? {};
  const tokens = (meta?.projections?.values?.["tokenUsage"] as Record<string, unknown>) ?? {};

  return {
    sessionId,
    title: titleOf(meta),
    turns,
    steps: sortedLanes.length,
    startTime,
    endTime,
    durationMs: endTime - startTime,
    trace,
    lanes: sortedLanes,
    toolCalls: toolCalls.sort((a, b) => a.seq - b.seq),
    files,
    tokenRow: {
      turns: num(stats.turns),
      steps: num(stats.steps),
      llmMs: num(stats.llmMs),
      toolMs: num(stats.toolMs),
      outputTokens: num(tokens.outputTokens),
      cacheReadTokens: num(tokens.cacheReadTokens),
    },
    latency,
    messages,
  };
}

function foldContentText(content: unknown, role: string): string {
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as { type?: string; text?: unknown };
      if (b && typeof b.text === "string") parts.push(b.text);
    }
  } else if (typeof content === "string") {
    parts.push(content);
  }
  return parts.join("\n");
}

function titleOf(meta?: SessionSummary): string {
  const t = meta?.projections?.values?.["title"];
  return typeof t === "string" && t.length > 0 ? t : meta?.sessionId ?? "";
}

function extractFiles(haystack: string): string[] {
  const matches = haystack.match(PATH_EXT) ?? [];
  return [...new Set(matches.map((m) => m.trim()).filter((p) => p.length > 1 && p.length < 300))].slice(0, 200);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
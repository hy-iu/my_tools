import { SessionStore } from "../src/host/sessionStore";
import { buildTrajectory } from "../src/host/trajectoryModel";
import { trajectoryHtml } from "../src/webview/trajectoryHtml";

async function main(): Promise<void> {
  const store = new SessionStore(process.env.DSH_WEB_URL ?? "http://127.0.0.1:3080");
  const sessions = await store.listSessions();
  const target =
    sessions.find((s) => s.sessionId.startsWith("884b7809")) ??
    sessions.find((s) => !s.blank) ??
    sessions[0];

  const h = await store.readHistory(target.sessionId, { maxMessages: 50 });
  const model = buildTrajectory(target.sessionId, h.events.map((e) => e.event), target);

  console.log(JSON.stringify({
    sessionId: model.sessionId,
    title: model.title.slice(0, 40),
    turns: model.turns,
    steps: model.steps,
    durationMs: model.durationMs,
    trace: model.trace.length,
    lanes: model.lanes.length,
    toolCalls: model.toolCalls.length,
    files: model.files.length,
    latency: model.latency.length,
    messages: model.messages.length,
    filesSample: model.files.slice(0, 6),
  }, null, 2));

  const checks: [string, boolean][] = [
    ["steps > 0", model.steps > 0],
    ["trace events", model.trace.length > 0],
    ["tool calls", model.toolCalls.length > 0],
    ["lanes == latency", model.lanes.length === model.latency.length],
    ["files deduped", new Set(model.files).size === model.files.length],
  ];

  const html = trajectoryHtml(model, "test-nonce");
  const open = '<script type="application/json" id="data">';
  const start = html.indexOf(open) + open.length;
  const end = html.indexOf("</script>", start);
  const island = html.slice(start, end);
  let parsed: unknown = null;
  try { parsed = JSON.parse(island); } catch { /* noop */ }
  checks.push(["json island round-trips", parsed !== null && (parsed as { sessionId?: string }).sessionId === target.sessionId]);
  checks.push(["no raw '<' leaked into island", !island.includes("<")]);
  checks.push(["sections present", ["时间线", "散点-折线", "Comfy 流", "归因图", "关联式转写"].every((s) => html.includes(s))]);
  checks.push(["replay animation hook", html.includes("回放") && html.includes("replayBtn") && html.includes('id="cursor"')]);

  for (const [name, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${name}`);
  const pass = checks.every(([, ok]) => ok);
  console.log(pass ? "\nPASS ✓" : "\nFAIL ✗");
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
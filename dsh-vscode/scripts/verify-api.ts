import { SessionStore } from "../src/host/sessionStore";
import type { SessionEvent, SessionSummary } from "../src/contract/session";

async function main(): Promise<void> {
  const store = new SessionStore(process.env.DSH_WEB_URL ?? "http://127.0.0.1:3080");

  const sessions = await store.listSessions();
  console.log("sessions total :", sessions.length);
  const rich = sessions.filter((s) => !s.blank);
  console.log("non-blank      :", rich.length);

  const target: SessionSummary = rich.find((s) => s.sessionId.startsWith("80fa39a9")) ?? rich[0];
  const title = String(target.projections?.values?.["title"] ?? "");
  console.log(`\ntarget         : ${target.sessionId} (${target.agentPreset ?? "?"}) ${title.slice(0, 50)}`);

  const h = await store.readHistory(target.sessionId, { maxMessages: 2 });
  const typeCounts: Record<string, number> = {};
  const toolCalls: Record<string, number> = {};
  const steps = new Set<number>();
  let firstTime = Infinity;
  let lastTime = 0;
  for (const entry of h.events) {
    const e: SessionEvent = entry.event;
    typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
    const step = (e.data?.step as number) ?? undefined;
    if (step !== undefined) steps.add(step);
    if (e.type === "tool/call") {
      const name = String((e.data?.name as string) ?? "?");
      toolCalls[name] = (toolCalls[name] ?? 0) + 1;
    }
    firstTime = Math.min(firstTime, e.time);
    lastTime = Math.max(lastTime, e.time);
  }
  console.log("events         :", h.events.length, `(window ${Math.round((lastTime - firstTime) / 1000)}s)`);
  console.log("event types    :", typeCounts);
  console.log("tool calls     :", toolCalls);
  console.log("steps          :", [...steps].sort((a, b) => a - b).join(", "));
  console.log("hasMore        :", h.hasMore);

  const presets = await store.listPresets();
  console.log(`\nagentPreset.list: ${presets.presets.length} presets, authorable=${presets.authorable}, hasDocument=${presets.hasDocument}`);
  console.log("names          :", presets.presets.map((p) => (p as { id?: string })?.id ?? "?").join(", "));
  console.log("\nPASS ✓ (native /api cold-read works)");
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
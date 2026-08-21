import * as vscode from "vscode";
import type { SessionSummary } from "../contract/session";
import { SessionStore } from "./sessionStore";

/**
 * A "会话" directory over the native `/api` session list. Empty (not error) when
 * the DSH Web server is not running, so the headless-only extension surface
 * keeps working. Rich hover tooltips carry the per-session stats — a first,
 * cheap "hover" presentation of the trajectory metadata.
 */
export class SessionNode extends vscode.TreeItem {
  constructor(public readonly summary: SessionSummary) {
    super(titleOf(summary), vscode.TreeItemCollapsibleState.None);
    this.description = describe(summary);
    this.iconPath = new vscode.ThemeIcon(summary.running ? "sync~spin" : "comment-discussion");
    this.tooltip = new vscode.MarkdownString(tooltipMarkdown(summary));
    this.contextValue = "dsh.session";
    this.command = { command: "dsh.openSessionTrajectory", title: "打开轨迹", arguments: [summary] };
  }
}

export class DshSessionProvider implements vscode.TreeDataProvider<SessionNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly store: SessionStore) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: SessionNode): SessionNode {
    return node;
  }

  async getChildren(node?: SessionNode): Promise<SessionNode[]> {
    if (node) return [];
    try {
      const sessions = await this.store.listSessions();
      return sessions.filter((s) => !s.blank).map((s) => new SessionNode(s));
    } catch {
      return []; // DSH web not reachable — degrade to an empty tree.
    }
  }
}

function titleOf(s: SessionSummary): string {
  const title = s.projections?.values?.["title"];
  return typeof title === "string" && title.length > 0 ? title : s.sessionId;
}

function sessionStats(s: SessionSummary): Record<string, unknown> {
  return (s.projections?.values?.["sessionStats"] as Record<string, unknown>) ?? {};
}

function describe(s: SessionSummary): string {
  const stats = sessionStats(s);
  const tokens = (s.projections?.values?.["tokenUsage"] as Record<string, unknown>) ?? {};
  const parts: string[] = [];
  if (s.agentPreset) parts.push(s.agentPreset);
  if (stats.turns !== undefined) parts.push(`${stats.turns}轮/${stats.steps}步`);
  if (typeof tokens.outputTokens === "number") parts.push(`${fmt(tokens.outputTokens)}tok`);
  return parts.join(" · ");
}

function tooltipMarkdown(s: SessionSummary): string {
  const stats = sessionStats(s);
  const tokens = (s.projections?.values?.["tokenUsage"] as Record<string, unknown>) ?? {};
  const lines = [
    `**${escapeMd(titleOf(s))}**`,
    `sessionId: \`${s.sessionId}\``,
    s.cwd ? `cwd: \`${s.cwd}\`` : "",
    s.agentPreset ? `preset: \`${s.agentPreset}\`` : "",
    s.running ? "状态: **运行中**" : "状态: 空闲",
    `turns: ${stats.turns ?? 0} · steps: ${stats.steps ?? 0} · llm: ${fmt(Number(stats.llmMs ?? 0))}ms`,
    `tokens: ${fmt(Number(tokens.outputTokens ?? 0))} out / ${fmt(Number(tokens.cacheReadTokens ?? 0))} cache`,
  ].filter((l) => l.length > 0);
  return lines.join("  \n");
}

function escapeMd(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|>]/g, "\\$&");
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}
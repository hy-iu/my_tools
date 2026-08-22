import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { SessionSummary } from "../contract/session";
import { SessionStore } from "./sessionStore";
import { buildTrajectory } from "./trajectoryModel";
import { trajectoryHtml } from "../webview/trajectoryHtml";

const MAX_MESSAGES = 500;

/** One singleton trajectory panel; reopening a session replaces the previous. */
export class TrajectoryPanel {
  private static current?: vscode.WebviewPanel;

  constructor(private readonly store: SessionStore) {}

  async open(session: SessionSummary): Promise<void> {
    let historyWindow;
    try {
      historyWindow = await this.store.readHistory(session.sessionId, { maxMessages: MAX_MESSAGES });
    } catch (err) {
      void vscode.window.showErrorMessage(
        `DSH: 无法读取会话轨迹 — ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const model = buildTrajectory(session.sessionId, historyWindow.events.map((e) => e.event), session);

    TrajectoryPanel.current?.dispose();
    const panel = vscode.window.createWebviewPanel(
      "dsh.trajectory",
      `DSH 轨迹 · ${(model.title || model.sessionId).slice(0, 40)}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.webview.html = trajectoryHtml(model, randomUUID());
    panel.onDidDispose(() => {
      if (TrajectoryPanel.current === panel) TrajectoryPanel.current = undefined;
    });
    TrajectoryPanel.current = panel;
  }
}
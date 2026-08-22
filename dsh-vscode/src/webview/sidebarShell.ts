import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { shellHtml } from "./htmlTemplate";

/**
 * Flavor-A sidebar shell: a host toolbar wrapping an iframe into the running
 * DSH Web UI. Retention is on so the iframe and its WebSocket connection stay
 * alive while the view is hidden.
 */
export class DshWebShellProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "dsh.webui";

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      enableForms: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };

    const render = (): void => {
      const webUrl = currentWebUrl();
      view.webview.html = shellHtml(webUrl, randomUUID());
    };

    view.webview.onDidReceiveMessage((message: { kind?: string }) => {
      if (message.kind === "openInBrowser") {
        void vscode.env.openExternal(vscode.Uri.parse(currentWebUrl()));
      } else if (message.kind === "reload") {
        render();
      }
    });

    render();
  }
}

function currentWebUrl(): string {
  return vscode.workspace.getConfiguration("dsh").get<string>("webUrl") ?? "http://127.0.0.1:3080";
}
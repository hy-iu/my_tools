import * as path from "node:path";
import * as vscode from "vscode";
import { resolveDshHome } from "./dshHome";
import { locateDsh, resolveDshInstallDir } from "./dshLocator";
import { readModelDirectory, readPresets, readSkills } from "./diskReader";

export class OverviewNode extends vscode.TreeItem {
  constructor(
    label: string,
    description: string | undefined,
    icon: string,
    public readonly children: OverviewNode[] = [],
    tooltip?: string,
  ) {
    super(
      label,
      children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
    if (tooltip) this.tooltip = tooltip;
  }
}

/**
 * The P1 "目录" view: model directory → provider → model, agent presets, and
 * skills, all read read-only from the DSH data home (never `.credentials.yaml`).
 */
export class DshOverviewProvider implements vscode.TreeDataProvider<OverviewNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<OverviewNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: OverviewNode): OverviewNode {
    return node;
  }

  getChildren(node?: OverviewNode): OverviewNode[] {
    if (node) return node.children;

    const config = vscode.workspace.getConfiguration("dsh");
    const home = resolveDshHome(config.get<string>("home"));
    const bin = locateDsh(config.get<string>("executablePath"));
    const installDir = bin ? resolveDshInstallDir(bin) : undefined;

    const md = readModelDirectory(home);
    const presets = readPresets(home, installDir);
    const skills = readSkills(home);

    const sections: OverviewNode[] = [];

    const providerNodes = md.providers.map((p) => {
      const modelNodes = p.models.map(
        (m) =>
          new OverviewNode(
            m.name ? `${m.name} (${m.id})` : m.id,
            dims(m.contextWindow, m.maxTokens),
            "symbol-value",
          ),
      );
      return new OverviewNode(
        p.name ? `${p.id} · ${p.name}` : p.id,
        `${p.models.length} 模型`,
        "symbol-keyword",
        modelNodes,
      );
    });
    sections.push(
      new OverviewNode(
        `模型目录 (${md.providers.length})`,
        md.defaultModel ? `默认 ${md.defaultProvider}/${md.defaultModel}` : undefined,
        "library",
        providerNodes,
      ),
    );

    const presetNodes = presets.map((pr) => {
      const children = pr.broken
        ? []
        : [
            openableNode("组装 · agent.cordis.yml", "symbol-property", path.join(pr.path, "agent.cordis.yml")),
            openableNode("元数据 · preset.yml", "info", path.join(pr.path, "preset.yml")),
          ];
      return new OverviewNode(
        pr.name ? `${pr.id} · ${pr.name}` : pr.id,
        pr.broken ?? pr.trust,
        pr.broken ? "warning" : "symbol-method",
        children,
        pr.description,
      );
    });
    sections.push(
      new OverviewNode(`Agent Presets (${presets.length})`, undefined, "symbol-class", presetNodes),
    );

    const skillNodes = skills.map(
      (s) => new OverviewNode(s.id, undefined, s.kind === "dir" ? "folder" : "file", []),
    );
    sections.push(
      new OverviewNode(`Skills (${skills.length})`, undefined, "symbol-function", skillNodes),
    );

    return sections;
  }
}

const COMMAND_OPEN_FILE = "dsh.openFile";

function openableNode(label: string, icon: string, filePath: string): OverviewNode {
  const node = new OverviewNode(label, undefined, icon);
  node.command = { command: COMMAND_OPEN_FILE, title: "打开", arguments: [filePath] };
  return node;
}

function dims(contextWindow?: number, maxTokens?: number): string {
  const parts: string[] = [];
  if (contextWindow) parts.push(`ctx ${humanReadable(contextWindow)}`);
  if (maxTokens) parts.push(`max ${humanReadable(maxTokens)}`);
  return parts.join(" · ");
}

function humanReadable(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}
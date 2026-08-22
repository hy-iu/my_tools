import * as vscode from "vscode";
import { spawn, type ChildProcess } from "node:child_process";
import { locateDsh, smokeTest } from "./host/dshLocator";
import { DshOverviewProvider } from "./host/overviewTree";
import { DshWebShellProvider } from "./webview/sidebarShell";
import { diffScan, scanTree } from "./host/workspaceChanges";
import { DshHeadProvider, HEAD_SCHEME, openChangeDiff } from "./host/diffProvider";
import { SessionStore } from "./host/sessionStore";
import { DshSessionProvider } from "./host/sessionTree";
import { TrajectoryPanel } from "./host/trajectoryPanel";
import type { SessionSummary } from "./contract/session";
import type { WorkspaceChange } from "./host/workspaceChanges";
import { applyChangeDecorations, DshChangeCodeLensProvider } from "./host/changeDecorations";

const COMMAND_RUN = "dsh.runSelectionHeadless";
const COMMAND_PANEL = "dsh.showPanel";
const COMMAND_REFRESH = "dsh.refreshOverview";
const VIEW_OVERVIEW = "dsh.overview";
const CONFIG_EXECUTABLE = "dsh.executablePath";

/**
 * Conservative cap on the task text handed to `dsh --profile headless` as a
 * single argv element. macOS `kern.argmax` is ~1 MiB total (args + env), so
 * this leaves ample headroom for the process environment.
 */
const MAX_TASK_CHARS = 200_000;

// ---------------------------------------------------------------------------
// task text
// ---------------------------------------------------------------------------

/**
 * Build the task text for a headless run: the active selection (trimmed) if
 * non-empty, otherwise the whole active document text (trimmed). Whitespace-only
 * input is rejected up front, mirroring DSH's own rejection.
 */
function taskFromEditor(): string | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;

  const selection = editor.document.getText(editor.selection).trim();
  if (selection.length > 0) return selection;

  const wholeFile = editor.document.getText().trim();
  if (wholeFile.length > 0) return wholeFile;

  return null;
}

function hasActiveSelection(): boolean {
  const editor = vscode.window.activeTextEditor;
  return !!editor && !editor.selection.isEmpty && editor.document.getText(editor.selection).trim().length > 0;
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

// ---------------------------------------------------------------------------
// process governance
// ---------------------------------------------------------------------------

const procs = new Set<ChildProcess>();

/**
 * Terminate a spawned `dsh` and its whole process group. `detached: true` puts
 * the child in its own group, so a negative pid reaches DSH's own forked child
 * agents too, not just the top-level process.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.killed) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  const pid = child.pid;
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }, 3000);
  timer.unref?.();
}

// ---------------------------------------------------------------------------
// status bar
// ---------------------------------------------------------------------------

let statusBar: vscode.StatusBarItem;
let changeLens: DshChangeCodeLensProvider | undefined;
let output: vscode.OutputChannel | undefined;
let runningSince = 0;

function setStatus(state: "idle" | "running" | "error"): void {
  if (state === "running") {
    const secs = Math.round((Date.now() - runningSince) / 1000);
    statusBar.text = "$(sync~spin) DSH " + secs + "s";
    statusBar.tooltip = "DSH 任务运行中（" + secs + "s）— 点击打开面板终止。";
    return;
  }
  if (state === "error") {
    statusBar.text = "$(error) DSH";
    statusBar.tooltip = "上次 DSH 任务失败 — 点击打开面板 / 查看输出。";
    return;
  }
  statusBar.text = "$(sparkle) DSH";
  statusBar.tooltip = "点击打开 DSH 面板：查看进程状态 / 手动选任务 / 打开 Web UI。";
}

// ---------------------------------------------------------------------------
// command
// ---------------------------------------------------------------------------

async function runHeadless(): Promise<void> {
  if (procs.size > 0) {
    vscode.window.showWarningMessage("DSH: 已有一个任务在运行，请先等它结束或在面板中终止它。");
    return;
  }

  const task = taskFromEditor();
  if (task === null) {
    vscode.window.showWarningMessage("DSH: 请先选中文本或打开一个文件。");
    return;
  }

  if (task.length > MAX_TASK_CHARS) {
    const action = await vscode.window.showWarningMessage(
      `DSH: 任务 ${task.length.toLocaleString()} 字符，超出单参数上限。请选更小的片段，或改用 Web UI。`,
      "Copy task",
    );
    if (action === "Copy task") await vscode.env.clipboard.writeText(task);
    return;
  }

  // 未选中片段 = 整文件发送；大文件先确认，避免误触整文件任务。
  if (!hasActiveSelection() && task.length > 4000) {
    const action = await vscode.window.showWarningMessage(
      `DSH: 未选中片段，将把活动文件全文（${task.length.toLocaleString()} 字符）作为任务发送。确定继续？`,
      "发送全文",
      "取消",
    );
    if (action !== "发送全文") return;
  }

  const config = vscode.workspace.getConfiguration("dsh");
  const dsh = locateDsh(config.get<string>(CONFIG_EXECUTABLE));
  if (dsh === null) {
    const action = await vscode.window.showErrorMessage(
      "DSH: 未找到 `dsh` 可执行文件。请安装 @deepseek-ai/dsh，或在设置中指定 `dsh.executablePath`。",
      "Open Settings",
    );
    if (action === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", CONFIG_EXECUTABLE);
    }
    return;
  }

  if (!smokeTest(dsh)) {
    const action = await vscode.window.showErrorMessage(
      `DSH: ${dsh} 存在但 \`dsh --version\` 失败，请检查路径或权限。`,
      "Open Settings",
    );
    if (action === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", CONFIG_EXECUTABLE);
    }
    return;
  }

  const out = (output ??= vscode.window.createOutputChannel("DSH"));
  out.show(true);
  out.appendLine(
    `$ dsh --profile headless <task of ${task.length} chars>` +
      (workspaceRoot() ? `  (cwd: ${workspaceRoot()})` : ""),
  );

  setStatus("running");
  runningSince = Date.now();
  const startedAt = runningSince;
  const root = workspaceRoot();
  const beforeScan = root ? scanTree(root) : undefined;

  const child = spawn(dsh, ["--profile", "headless", task], {
    cwd: root,
    env: process.env,
    detached: true, // own process group → killTree(-pid) reaches DSH's children
    windowsHide: true,
  });
  procs.add(child);

  let stderr = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    out.append(text.endsWith("\n") ? text : text + "\n");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderr += text;
    out.append(text.endsWith("\n") ? text : text + "\n");
  });
  child.on("error", (err) => {
    procs.delete(child);
    runningSince = 0;
    out.appendLine(`spawn error: ${err.message}`);
    setStatus("error");
  });
  child.on("close", (code, signal) => {
    procs.delete(child);
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    out.appendLine(
      `\n— finished in ${secs}s (exit ${code ?? "null"}${signal ? `, signal ${signal}` : ""}) —`,
    );
    const ok = code === 0 && stderr.trim() === "";
    if (ok && root && beforeScan) {
      const changes = diffScan(beforeScan, scanTree(root));
      if (changes.length > 0) {
        out.appendLine(`\n工作区改动 (${changes.length}):`);
        for (const c of changes.slice(0, 20)) out.appendLine(`  ${c.kind.padEnd(8)} ${c.relPath}`);
        if (changes.length > 20) out.appendLine(`  … 共 ${changes.length} 项`);
        changeLens?.mark(root, changes);
        void applyChangeDecorations(root, changes);
        void vscode.window
          .showInformationMessage(`DSH: 运行期间 ${changes.length} 个文件发生变化`, "查看 diff", "忽略")
          .then((action) => {
            if (action === "查看 diff") for (const c of changes.slice(0, 10)) openChangeDiff(root, c);
          });
      }
    }
    runningSince = 0;
    setStatus(ok ? "idle" : "error");
  });
}

function killAll(): void {
  for (const proc of procs) killTree(proc);
  procs.clear();
  runningSince = 0;
  setStatus("idle");
  output?.appendLine("— 已请求终止所有 DSH 任务 —");
}

function showOutput(): void {
  const out = (output ??= vscode.window.createOutputChannel("DSH"));
  out.show(true);
}

function webUrl(): string {
  return vscode.workspace.getConfiguration("dsh").get<string>("webUrl") ?? "http://127.0.0.1:3080";
}

function openWebExternal(): void {
  void vscode.env.openExternal(vscode.Uri.parse(webUrl()));
}

/** VSCode 内置 Simple Browser（编辑器标签页打开）。不可用时回退系统浏览器。 */
async function openWebSimpleBrowser(): Promise<void> {
  const uri = vscode.Uri.parse(webUrl());
  try {
    await vscode.commands.executeCommand("simpleBrowser.api.open", uri);
  } catch {
    try {
      await vscode.commands.executeCommand("simpleBrowser.show", uri);
    } catch {
      void vscode.window.showWarningMessage("DSH: 内置 Simple Browser 不可用，已改用系统浏览器。");
      openWebExternal();
    }
  }
}

/** 侧边栏 iframe 视图（dsh.webui）。 */
function openWebSidebar(): void {
  void vscode.commands.executeCommand("dsh.webui.focus");
}

async function showPanel(): Promise<void> {
  const running = procs.size > 0;
  const elapsed = running ? Math.round((Date.now() - runningSince) / 1000) : 0;

  interface PanelItem extends vscode.QuickPickItem {
    action: string;
  }
  const items: PanelItem[] = [];
  items.push(
    running
      ? { label: `$(sync~spin) 状态：运行中 · ${elapsed}s`, description: "可执行下面「终止当前任务」", action: "" }
      : { label: "$(circle-outline) 状态：空闲", description: "无运行中的 headless 任务", action: "" },
  );
  items.push({ label: "$(play) 运行当前选区 / 活动文件（headless）", description: "把选中文本或活动文件作为任务发送", action: COMMAND_RUN });
  items.push({ label: "$(globe) Web UI · 系统浏览器", description: "用系统默认浏览器打开", action: "dsh.openWebExternal" });
  items.push({ label: "$(browser) Web UI · 内置 Simple Browser", description: "用 VSCode 内置浏览器在编辑器标签页打开", action: "dsh.openWebSimpleBrowser" });
  items.push({ label: "$(layout-sidebar-right) Web UI · 侧边栏视图", description: "在 DSH 侧边栏的 iframe 视图里打开", action: "dsh.openWebSidebar" });
  items.push({ label: "$(output) 查看 DSH 输出", description: "显示 headless 输出通道", action: "dsh.showOutput" });
  items.push({ label: "$(refresh) 刷新会话列表", description: "重新拉取会话", action: "dsh.refreshSessions" });
  if (running) {
    items.push({ label: "$(debug-stop) 终止当前任务", description: "SIGTERM 停止进程组，3s 未退出再 SIGKILL", action: "dsh.stopTask" });
  }

  const pick = await vscode.window.showQuickPick(items, {
    title: "DSH 面板",
    placeHolder: running ? `DSH 运行中（${elapsed}s）— 选择操作` : "DSH — 选择操作",
    ignoreFocusOut: true,
  });
  if (!pick || !pick.action) return;
  await vscode.commands.executeCommand(pick.action);
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = COMMAND_PANEL;
  setStatus("idle");
  statusBar.show();

  const overview = new DshOverviewProvider();
  const webShell = new DshWebShellProvider(context.extensionUri);
  const sessionStore = new SessionStore(
    vscode.workspace.getConfiguration("dsh").get<string>("webUrl") ?? "http://127.0.0.1:3080",
  );
  const sessions = new DshSessionProvider(sessionStore);
  const trajectory = new TrajectoryPanel(sessionStore);
  const lens = new DshChangeCodeLensProvider();
  changeLens = lens;

  context.subscriptions.push(
    statusBar,
    vscode.commands.registerCommand(COMMAND_RUN, runHeadless),
    vscode.commands.registerCommand(COMMAND_PANEL, showPanel),
    vscode.commands.registerCommand("dsh.stopTask", killAll),
    vscode.commands.registerCommand("dsh.showOutput", showOutput),
    vscode.commands.registerCommand("dsh.openWebExternal", openWebExternal),
    vscode.commands.registerCommand("dsh.openWebSimpleBrowser", openWebSimpleBrowser),
    vscode.commands.registerCommand("dsh.openWebSidebar", openWebSidebar),
    vscode.window.registerTreeDataProvider(VIEW_OVERVIEW, overview),
    vscode.commands.registerCommand(COMMAND_REFRESH, () => overview.refresh()),
    vscode.window.registerTreeDataProvider("dsh.sessions", sessions),
    vscode.commands.registerCommand("dsh.refreshSessions", () => sessions.refresh()),
    vscode.commands.registerCommand("dsh.openSessionTrajectory", (session: SessionSummary) => {
      trajectory.open(session).catch((err) => {
        void vscode.window.showErrorMessage(`DSH: 打开轨迹失败 — ${err instanceof Error ? err.message : String(err)}`);
      });
    }),
    vscode.commands.registerCommand("dsh.openFile", (filePath: string) => {
      void vscode.window.showTextDocument(vscode.Uri.file(filePath), { preview: true, preserveFocus: false });
    }),
    vscode.window.registerWebviewViewProvider(DshWebShellProvider.viewType, webShell, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, lens),
    vscode.commands.registerCommand("dsh.openChangeDiff", (r: string, c: WorkspaceChange) => {
      openChangeDiff(r, c);
    }),
    vscode.workspace.registerTextDocumentContentProvider(HEAD_SCHEME, new DshHeadProvider()),
    new vscode.Disposable(() => {
      for (const proc of procs) killTree(proc);
      procs.clear();
    }),
  );
}

export function deactivate(): void {
  runningSince = 0;
  for (const proc of procs) killTree(proc);
  procs.clear();
}
# REVIEW-03 · VSCode 扩展工程可行性评审

> 角色 ③（VSCode 工程可行性）。只给增量判断，不复述 DESIGN.md。
> 事实依据：本机 `dsh@0.1.0-rc.6`，二进制 `/opt/homebrew/bin/dsh` → 软链 →
> `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`。所有"是否真实存在"的
> 断言均经源码/HTTP 探测验证，未验证项已标注。

---

## 一、逐条裁决

| 评审点 | 裁决 | 关键依据 / 增量 |
|---|---|---|
| §6 消息契约（草） | **需调整** | 形状太松散：未给判别字段、未区分 webview 类型、未规定 `acquireVsCodeApi` 单例边界。补契约定见第二节。最严重结构问题：iframe 壳是**跨源**的，**无法承载任何契约消息**——§6 的 `runHeadless/openPreset/focusFile` 只能挂在自绘 webview 或 host 侧命令上。 |
| §1 路线 A：`<iframe src="http://127.0.0.1:3080">` | **可行（带约束）** | 实测 3080 根请求返回 `200`，**响应头没有任何 CSP / X-Frame-Options / frame-ancestors** → 服务端不挡 framing。唯一 framing 约束来自 webview 自身 CSP 的 `frame-src`。**`--trusted-host` 不存在**：在整棵 `@deepseek-ai` 源码树里 grep 不到该 flag 或 settings key；DSH 的信任栅栏只有"绑定 127.0.0.1、CLI 禁止 `--host 0.0.0.0`"这一层。故**不需要**给 127.0.0.1 加任何 trust 标记。登录态：本地无 auth，无需处理。 |
| §1 路线 B：`child_process.spawn('dsh', [...,'--profile','headless',...])` | **可行（带治理）** | 路径探测、流式读取、优雅终止、防僵尸见第四节。一个已坐实的限制：`dsh --profile headless "…"` 的语义是"答完即退出、**打印最终答案**"——**stdout 极可能只有最终答案、无中间轨迹**。中间轨迹落在 `DSH_SESSION_JSONL` 指向的 `session.jsonl.zstd`（**zstd 压缩的 JSONL**），不能裸 `tail -f`。这直接影响 §7 风险 5 的答案。 |
| §9 技术栈 | **可行/需微调** | esbuild + `@vscode/vsce` 正确；Node extension host 正确。三处微调：(1) P0 的"文件修改 diff"应优先用 `registerTextDocumentContentProvider` + 内置 diff editor，**不必起 webview**；(2) 图表库 ECharts(~1MB) 偏重，与 §4"信息密度↔性能"原则相悖，建议 `uPlot`(~40KB) 负责散点折线，`d3-force` 负责网状；(3) 分层规则要写死：`host/` 不得 import `webview-app/`，反之亦然，`contract/` 仅类型、双方共享。 |
| 框架选择 | **建议分阶段** | P0 原生 TS+DOM（侧边栏只是 iframe+工具条，框架是死重）；P1 当 preset 面板/轨迹时间线的手写 DOM 超过 ~300 LOC 再引入 **Preact + htm**（免 JSX 编译、~3KB）。**不要用 React**（bundle 臃肿、hooks 模型对一个嵌入式面板是 overkill）。Solid 亦可，但 Preact 与 esbuild 的耦合更省心。 |

---

## 二、具体契约草案（替代 §6）

### 2.1 acquireVsCodeApi 边界（写死，避免实现期才发现）

- `acquireVsCodeApi()` 一个 webview **只能调一次**，且**只在 webview 内可调**（host 侧无此 API）。
- 跨源 iframe（路线 A）**拿不到** `acquireVsCodeApi`：它属于外层 webview 文档，跨源 iframe 既无 DOM 访问、也不会被 dsh app 主动 `window.parent.postMessage`。**→ iframe 壳 = 纯展示，零契约消息。**
- host 侧桥：`webview.onDidReceiveMessage(handler)` 收、`webview.postMessage(msg)` 发。
- 因此 §6 的消息列表**只适用于自绘 webview（flavor B）**；flavor A 的所有 host 动作走 `commands` / 工具条按钮，不走 postMessage。

### 2.2 TS 类型形状（`src/contract/protocol.ts`，host 与 webview 共用、仅类型）

```ts
// 信封：所有 postMessage 载荷套这一层。kind 做判别式联合的判别字段。
export type Wire<K extends string, P> = {
  kind: K;
  id?: string;        // 请求/响应关联用 UUID；fire-and-forget push 可省
  ts: number;         // 发送方单调时钟，host 可丢弃过期 stale 状态
  payload: P;
};

// ---------- webview → host（仅 flavor B）----------
export type ToHost =
  | Wire<"runHeadless", {
      task: string;
      context?: { selectionUri?: string; range?: [number, number]; cwd?: string };
      effort?: "low" | "medium" | "high";      // 即 reasoningEffort，UI 上标注 "juice ≈ effort"
    }>
  | Wire<"cancelHeadless", { id: string }>
  | Wire<"openPreset",    { presetDir: string }>
  | Wire<"focusFile",     { uri: string; range?: [number, number] }>
  | Wire<"renderGraph",   {
      kind: "tree" | "mesh" | "comfy" | "scatter";
      sessionId: string;
      opts?: { maxNodes?: number; cursor?: string };   // 强制虚拟化/降采样入口
    }>
  | Wire<"setReducedMotion", { enabled: boolean }>
  | Wire<"subscribe", { channel: "sessions" | "presets" | "trajectory" | "diffs"; cursor?: string }>;

// ---------- host → webview ----------
export type ToWeb =
  | Wire<"snapshot", {
      sessions: SessionSummary[];
      presets:   PresetSummary[];
      trajectory?: TrajectorySlice;
    }>
  | Wire<"headlessChunk",   { id: string; stream: "stdout" | "stderr"; text: string }>
  | Wire<"headlessDone",    { id: string; exitCode: number; finalAnswer: string; durationMs: number }>
  | Wire<"trajectoryDelta", { sessionId: string; events: TrajectoryEvent[] }>
  | Wire<"diffSummary",     { files: DiffFile[] }>
  | Wire<"renderError",     { id: string; message: string }>;

// 增量 push 契约：snapshot 是全量基线，之后只发 *Delta；webview 用 ts 去重保序。
// 大轨迹：renderGraph.opts.maxNodes 是硬上限，host 侧先降采样再发，禁止把上万节点灌进 webview。
```

### 2.3 host 侧路由骨架

```ts
// src/host/messageRouter.ts
type Handler = (payload: any, msg: Wire<string, any>) => ToWeb["payload"] | Promise<ToWeb["payload"] | void> | void;
const routes: Record<string, Handler> = {
  runHeadless:        headlessRunner.start,
  cancelHeadless:     headlessRunner.cancel,
  openPreset:         (p) => vscode.commands.executeCommand("dsh.openPreset", p.presetDir),
  focusFile:          (p) => focusFile(p.uri, p.range),
  renderGraph:        trajectoryStore.render,
  setReducedMotion:   (p) => { vscode.workspace.getConfiguration("dsh").update("reducedMotion", p.enabled, true); },
  subscribe:          subscribeBus.subscribe,
};
webview.onDidReceiveMessage(async (m: Wire<string, any>) => {
  const h = routes[m.kind];
  if (!h) return;
  const out = await h(m.payload, m);
  if (out !== undefined) webview.postMessage({ kind: `${m.kind}:result`, id: m.id, ts: Date.now(), payload: out });
});
```

---

## 三、webviewOptions / CSP 配置片段

### 3.1 flavor A · iframe 壳（侧边栏，纯展示 + host 工具条）

```ts
view.webview.options = {
  enableScripts: true,            // 必须：acquireVsCodeApi + 工具条 postMessage
  enableForms: true,              // dsh app 内含表单
  retainContextWhenHidden: true,  // 保活 iframe 与其 WS 连接
  localResourceRoots: [
    vscode.Uri.joinPath(ctx.extensionUri, "media"),   // 仅工具条资源
  ],
  // portMapping 通常无需：直连 127.0.0.1:3080 即可。仅当要走代理转发时才映射。
};
const nonce = randomUUID();
const toolbarUri = view.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "media", "bar.js"));
view.webview.html = /*html*/`<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  frame-src http://127.0.0.1:3080/ http://localhost:3080/;
  script-src 'nonce-${nonce}';
  style-src 'unsafe-inline';
  connect-src http://127.0.0.1:3080 ws://127.0.0.1:3080;  /* 工具条探活用，非必需 */
">
</head><body>
  <div id="bar"></div>
  <iframe id="shell" src="http://127.0.0.1:3080/"
         allow="clipboard-read; clipboard-write; fullscreen"
         style="width:100%;height:100%;border:0"></iframe>
  <script nonce="${nonce}" src="${toolbarUri}"></script>
</body></html>`;
// 注意：dsh app 走 window.__DSH_BOOT__ 由 dsh web server 注入，无法离线打包，
//       iframe 必须指向**运行中的** dsh web 进程，不能用本地构建副本替代。
```

要点：
- `frame-src` **必须显式列出** `http://127.0.0.1:3080/`（含尾斜杠更稳）与 `localhost` 别名；webview 默认 CSP 不允许 http: 帧。
- `default-src 'none'` 是基线，逐项放开。
- `sandbox`：webview 外层 iframe 自带 `sandbox`，**不要**在 `<iframe>` 上再加 `sandbox` 属性——会二次限制到 dsh app 跑不起来。
- 跨源 iframe 内的 WS/XHR 由 **dsh app 自身文档** 的 CSP 管控（实测为空 → 放行），**不受**外层 webview CSP 影响。

### 3.2 flavor B · 自绘可视化（panel，承载完整契约）

```ts
panel.webview.options = {
  enableScripts: true,
  retainContextWhenHidden: true,  // 大图保留 d3 仿真状态；若内存敏感可改 false 并由 host 重放 snapshot
  localResourceRoots: [
    vscode.Uri.joinPath(ctx.extensionUri, "webview-dist"),
    // 故意不放 workspace 根：文件内容经 postMessage 投递，不直接给 webview 读盘权限
  ],
};
const nonce = randomUUID();
const jsUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "webview-dist", "viz.js"));
panel.webview.html = /*html*/`<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  script-src 'nonce-${nonce}';
  style-src 'nonce-${nonce}' 'unsafe-inline';
  img-src ${panel.webview.cspSource} data:;
  connect-src ${panel.webview.cspSource};     /* 严禁 http:——B 桥只许与 host 通信 */
">
</head><body><div id="root"></div>
<script nonce="${nonce}" src="${jsUri}"></script>
</body></html>`;
```

两种 webview 权限对照：

| 维度 | flavor A（iframe 壳） | flavor B（自绘） |
|---|---|---|
| enableScripts | true | true |
| retainContextWhenHidden | true（保活 iframe+WS） | true（保留仿真/DOM 状态） |
| localResourceRoots | 仅 `media/` | 仅 `webview-dist/`，**不含 workspace** |
| CSP `frame-src` | 必须含 `http://127.0.0.1:3080/` | 不需要 |
| CSP `connect-src` | 允许 `http/ws 127.0.0.1:3080`（探活） | 仅 `${cspSource}`（禁止出网） |
| 承载契约消息 | **否（跨源，无桥）** | 是（完整 ToHost/ToWeb） |
| `--trusted-host` 需求 | **无此 flag** | 无 |

---

## 四、headless 子进程治理要点

### 4.1 `dsh` 路径探测（优先级递减）

```ts
// src/host/dshLocator.ts
async function locateDsh(ctx): Promise<string> {
  // 1. 用户配置覆盖
  const cfg = vscode.workspace.getConfiguration("dsh").get<string>("executablePath");
  if (cfg && fs.existsSync(cfg)) return fs.realpathSync(cfg);
  // 2. PATH 查找（跨平台，不依赖系统 which）
  try { return which.sync("dsh"); } catch { /* fall through */ }
  // 3. 已知安装位（homebrew / npm global）
  const candidates = [
    "/opt/homebrew/bin/dsh", "/usr/local/bin/dsh",       // mac homebrew
    path.join(npm.globalDir ?? "", "@deepseek-ai/dsh/lib/bin.js"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return fs.realpathSync(c);
  throw new Error("dsh not found; set `dsh.executablePath`");
}
```
- 探测后**冒烟**：`spawn(resolved, ["--version"], {timeout:3000})`，失败即提示用户配置。
- **不要**依赖 `$DSH_HOME` / `$DSH_SESSION_ID` 等环境变量：这些是 dsh **作为父进程时**才注入的，VSCode extension host 默认拿不到。仅 `~/.dsh` 路径硬编码作为磁盘读兜底。

### 4.2 流式读 stdout（而非等退出）

```ts
const proc = spawn(dsh, ["--profile","headless", task], {
  cwd: workspaceRoot,
  env: { ...process.env, DSH_HOME: dshHome, DSH_NONINTERACTIVE: "1" },  // 若存在该 env（未验证），关交互式 prompt
  windowsHide: true,
});
let buf = "";
proc.stdout.on("data", (chunk: Buffer) => {
  buf += chunk.toString("utf8");
  // headless 多半是"最终答案一次性吐出"，但仍按行 flush 给 webview，避免用户以为卡死
  webview.postMessage({ kind:"headlessChunk", id, stream:"stdout", text: chunk.toString(), ts:Date.now() });
});
proc.stderr.on("data", (c) => webview.postMessage({ kind:"headlessChunk", id, stream:"stderr", text:c.toString(), ts:Date.now() }));
proc.on("exit", (code, sig) => webview.postMessage({ kind:"headlessDone", id, exitCode:code??-1, finalAnswer:buf, durationMs, ts:Date.now() }));
```
- **不要** `await proc` / `execFile`（那是等退出）。`on('data')` 才是流。
- 中间轨迹**不在 stdout**：读 `$DSH_SESSION_JSONL` 指向的 `session.jsonl.zstd`。**zstd 压缩**，需流式解压器（`@mongodb-js/zstd` 或 `fzstd`），**不能** `fs.createReadStream().pipe(split())`。若 headless 不写该 env，退化为"完成后才读 session 目录"。

### 4.3 优雅终止 + 防僵尸

```ts
const procs = new Map<string, ChildProcess>();          // id → proc，session 级管理
function kill(id: string) {
  const p = procs.get(id); if (!p || p.killed) return;
  try { process.kill(-p.pid!, "SIGTERM"); }            // 整进程组终止（dsh 会 fork 子 agent）
  catch { p.kill("SIGTERM"); }
  setTimeout(() => { if (!p.killed) try { process.kill(-p.pid!, "SIGKILL"); } catch {/* already gone */} }, 3000);
}
// spawn 时必须：detached:true（建独立进程组，上面 -pid 才有效），但**不要** unref()（要让 host 等它）
const proc = spawn(dsh, args, { detached: true, windowsHide: true });
```
- 注册 `ctx.subscriptions.push(new Disposable(() => procs.forEach((_,id)=>kill(id))))` —— 扩展 deactivate 时全杀，防孤儿。
- `proc.on('exit')` 内 `procs.delete(id)` + `removeAllListeners()`，防句柄泄漏与"已死进程仍被 kill"。
- Windows 上 `process.kill(-pid)` 行为不同：用 `tree-kill` 包或 `taskkill /pid X /T /F`。

---

## 五、目录结构建议

```
dsh-vscode/
  package.json                # contributes: viewsContainers/views/commands/activationEvents
  esbuild.config.mjs          # 两 entry：extension host + webview-app
  tsconfig.json
  src/
    extension.ts              # activate/deactivate，挂 providers/commands/subscriptions
    contract/
      protocol.ts             # §2 的 Wire/ToHost/ToWeb（纯类型，host 与 webview 共用）
    host/
      dshLocator.ts           # 路径探测 + 冒烟
      headlessRunner.ts       # spawn/流式/kill/防僵尸
      webuiLauncher.ts        # 'dsh web' 生命周期：先探活 3080 再决定 attach/spawn
      diskReader.ts           # ~/.dsh 读 presets/skills/sessions（zstd 解码）
      messageRouter.ts        # onDidReceiveMessage → handler 分发
      diffProvider.ts         # registerTextDocumentContentProvider（P0 diff，不起 webview）
    webview/
      sidebarShell.ts         # flavor A provider（iframe + 工具条，零契约）
      vizPanel.ts             # flavor B provider（承载完整契约）
      htmlTemplate.ts         # CSP/nonce 组装，两 flavor 共用
    webview-app/              # 跑在 flavor B webview 内部
      main.ts                 # acquireVsCodeApi() 只在此调一次
      state.ts                # getState/setState 水合
      viz/                    # d3-force / uPlot / comfy DAG / scatter
  media/                      # 工具条图标/css（localResourceRoots A）
  webview-dist/               # esbuild 产物（localResourceRoots B），gitignore
  dist/                       # extension host 产物，gitignore
```
分层铁律：`host/` 可 import `contract/`，禁止 import `webview-app/`；`webview-app/` 可 import `contract/`，禁止 import `host/`。`extension.ts` 是唯一允许两边都引的地方。

---

## 六、看似简单实际是坑的点

**坑：§6 的消息契约默认适用于"所有 webview"——但 iframe 壳是跨源的，承载不了任何 postMessage。**

听起来像常识，但实现期最常踩：有人会以为"侧边栏也是 webview，那 `runHeadless` 就在侧边栏里发"，然后发现——
- `acquireVsCodeApi()` 只有**外层** webview 文档能调，且**只调一次**；跨源 iframe（dsh web app）既拿不到，也不会主动 `window.parent.postMessage`（dsh app 从没设计成被嵌入）。
- 外层 webview JS 对跨源 iframe **没有 DOM 访问、没有 postMessage 入口**（除非 dsh app 先发起，它不会）。
- 结果：**iframe 壳 = 纯展示，零程序化桥**。所有 `runHeadless/openPreset/focusFile` 必须挂在 **host 侧命令/工具条**，不能指望 iframe 内部触发。

**规避**：把契约明确二分——flavor A（iframe 壳）**不带任何 ToHost/ToWeb 消息**；flavor B（自绘）才走 §2 的完整契约。P0 的"用当前选区跑 headless"做成 `commands.registerCommand("dsh.runHeadlessOnSelection", …)` + 工具条按钮，而非塞进 iframe。

**附加坑（值得一提）**：`session.jsonl.zstd` 是 **zstd 压缩 JSONL**。若想给 route B 补"流式轨迹"，不能 `tail -f`——需流式 zstd 解码器，且 headless 退出前该文件未必 flush 完。P0 不要依赖轨迹流式，只用 stdout 最终答案 + 退出后磁盘读。

---

## 裁决

**可以按此开始写 P0**——前提是：契约只挂在 flavor B（自绘）与 host 命令上、iframe 作纯展示、`dsh` 路径探测含冒烟、`dsh web` 启动前先探活 3080（活则 attach、死才 spawn）、P0 diff 走 `TextDocumentContentProvider` 不起 webview。P0 **不依赖**任何未验证项（`/api`、headless 流式轨迹、reasoningEffort 跨 provider 生效），可在实测前安全开工。

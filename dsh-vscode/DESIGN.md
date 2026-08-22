# DSH VSCode 扩展 · 设计稿（V1.1，已按四评审定稿）

> 评审共识与分歧裁定见 [`REVIEW-SYNTHESIS.md`](REVIEW-SYNTHESIS.md)；可视化细则 [`REVIEW-02-可视化与信息设计.md`](REVIEW-02-可视化与信息设计.md)；工程细则 [`REVIEW-03-VSCode工程可行性.md`](REVIEW-03-VSCode工程可行性.md)。

> 工作名 `dsh-vscode`。本稿是"先评审、再实现"的蓝图：目标是把 DeepSeek Harness (DSH)
> 接进编辑器，并给它一个**信息密度远高于 iframe 壳**的观测/控制面。所有对 DSH 实力面的
> 判断都来自本机安装的 `@deepseek-ai/dsh@0.1.0-rc.6` 源码，字段级结论在文末备注。

## 0. 定位

相当于 WebUI（`http://127.0.0.1:3080`）的**编辑态伴侣**：

- 保留完整 WebUI 能力（iframe 壳，路线 A）；
- 补充编辑器才有的**文件/工作流直觉**：改动即 diff、工作即轨迹、子 agent 即可点开的配置与行为图谱；
- 用一次性的 **headless 桥**（路线 B）把"当前选区 / 文件 / 论文"快速喂给 DSH 拿结果；
- 仅在 P2 触碰 DSH 的原生 `/api` 双向桥（路线 C，风险最高）。

核心原则：**数据源优先走稳定面（子进程 + 磁盘文件），内部 rc 的 `/api` 协议只做"锦上添花"，不做 P0 依赖。**

## 1. 三层集成底座（路线 A+B+C）

| 层 | 手段 | 说明 |
|---|---|---|
| A · 壳 | `WebviewViewProvider`（sidebar）/ `WebviewPanel`，`<iframe src="http://127.0.0.1:3080">` | `enableScripts:true`、`retainContextWhenHidden:true`；可选 activation 时 `spawn('dsh',['web'])` |
| B · 桥 | `child_process` 跑 `dsh --profile headless "<任务>"`，stdout/最终答案 → `OutputChannel` + webview | 把当前选区/打开文件/命令行参数拼进任务，拿一次性结果 |
| C · 观测 | 读 DSH 会话/轨迹磁盘数据 + 可选 `/api` RPC + WS 下行 | P2：原生渲染，双向控制，风险最高 |

## 2. 数据源盘点（已核实，截至 `dsh@0.1.0-rc.6`）

1. **进程 · WebUI**：`dsh web`（= `--profile web`）→ HTTP + WS，绑定 `127.0.0.1:3080`（`--host 0.0.0.0` 被 CLI 故意禁止）。
2. **进程 · Headless**：`dsh --profile headless "job"` → 一个全新持久化会话，打印最终答案并退出。
3. **协议 · `/api`**：浏览器 UI 与后端的同款通信面，**复合分发**——Typert Gateway 认领一批 loopback-pinned 特权方法（`host.pickDirectory`/`settings.*`/`credentials.*`/`agentPreset.read|copy|openDocument|remove`），未认领的回落到 `dsh-host-apiproxy` 的普通 JSON RPC（`session.*`/`agentPreset.list`/`command.*`/`skill.*`）。不是普通 REST。下行两条 WS：`/api/events.mux` + `/api/events.host`。受 `--trusted-host` 信任栅栏约束（可重复，接受 `host[:port]`）。
4. **磁盘 · agent preset**：`<dshHome>/.agent-presets/`，每目录一份 `agent.cordis.yml`（工具/提示词/系统段的插件组成）+ 可选 `preset.yml`（`name`/`description` 只读显示）。子 agent = 一个 preset 组合。
5. **RPC · 模型/努力值**：`sessions.models({sessionId})` / `sessions.selectModel({provider, model, reasoningEffort})`。**provider=供应商、model=模型、reasoningEffort=“juice 值”在 DSH 的真实对应**（adapter-owned effort，见备注 1）。
6. **磁盘 · 其他**：`<dshHome>/skills/`（技能）、会话/transcript 持久化——**已实测确认**：`$DSH_HOME/sessions/<mangled-cwd>/<session-id>/session.jsonl.zstd`（zstd 压缩逐行 JSONL；header + 类型化事件，事件词典见 [`notes/dsh-surface-notes.md`](notes/dsh-surface-notes.md)）。
7. **磁盘 · 模型目录**：`~/.dsh/settings.yaml` 的 `llm-pi-ai.providers.<provider>.models[]`（id/name/contextWindow/maxTokens）+ `agent-default-model`。这是 §3 子 agent 配置可视化里 provider/model 的真相源；密钥经 `apiKeyEnv` 间接引用（插件只读模型目录，不读 `.credentials.yaml`）。

## 3. 子 agent 配置可视化（字段级映射）

用户关心的"供应商、模型、提示词、juice 值、行为"：翻译成 DSH 真实字段：

| 用户概念 | DSH 字段 / 来源 | 呈现 |
|---|---|---|
| 供应商 provider | `selectModel.provider` | 配置面板徽标 + 实体图节点属性 |
| 模型 model | `selectModel.model` | 同上 |
| juice 值（努力/成本预算） | `selectModel.reasoningEffort`（adapter-owned effort，**per-model 离散档**） | 离散徽标 + 散点颜色/阶跃（**不作连续折线**）；连续努力/成本曲线改用 `dsh-token-meter` token/latency |
| 提示词 / 工具 / 系统段 | preset 的 `agent.cordis.yml` 组成 | 目录树展开 + 只读高亮面板 |
| 行为 | agent-loop 的轨迹 / tool 调用日志 | 时间线 + comfy 流 DAG |

**备注**：DSH 没有字面量 `juice` 字段（那是 Goose 生态的词）；语义对等的是 `reasoningEffort`（adapter-owned、per-model 离散分类档、会话级快照）。注意 `session.selectModel` 会写入**部署默认**，不是纯观察。UI 可标注"juice ≈ reasoningEffort"。

## 4. 可视化层（六类呈现 × DSH 数据 × 编辑器载体）

| 呈现模式 | 映射的 DSH 概念 | 建议载体 + 交互 |
|---|---|---|
| 对话框（关联式 transcript） | 会话消息序列（流式 token） | Webview 虚拟滚动；点消息内文件 span → editor + gutter 高亮该 turn 改动 |
| 目录 | presets / skills / 会话清单 / **改动文件清单（工作产出）** | 侧边栏 `TreeView` 懒加载 |
| 树状 | 消息树、子 agent 父子派生（tool 调用树并入 comfy 流） | TreeView 懒展开；点节点 → editor 定位 |
| 网状（**归因图**） | agent↔file↔tool 归因（provenance：谁经哪个 tool 碰了哪个文件） | 粗图聚合 + ≤50 邻域下钻；点 file → 打开 + agent 行 blame 高亮 |
| comfy 流 | tool 调用 DAG（工具名=节点，输入/输出=边）；仅真实分叉场景，线性会话退化为列表 | 大图 panel + minimap + 分页；点节点 → 跳源码/diff |
| 散点-折线 | token / latency / tool 次数（effort 作**离散色+阶跃**） | uPlot + LTTB 降采样；点某 turn → 联动其他视图 |
| 动画（横切原则） | 流式 token、tool 运行脉冲、子 agent 派生（非独立第七类） | 尊重 `prefers-reduced-motion`；运行态脉冲、非运行态静态色 |

**信息密度原则**：同一份轨迹数据可同时以"时间线（散点折线）"与"结构（comfy DAG）"两视角切换，二者共享点击定位；大轨迹必须虚拟化/降采样，不允许一次性渲染上万节点。

**共享点击目标契约**：任一可视化节点（图/树/DAG/transcript 内）统一解析为 `{file, lineRange, turn, agent/preset, beforeSnapshot, afterSnapshot}`，editor 用 `vscode.diff` 打开 + gutter 归因高亮 —— 所有视图的点击都落回这一契约，而非只"跳源码"。

## 5. 编辑器特性利用（一等公民）

- **文件修改** → 六件套：agent-blame gutter + CodeLens 符号级 + 自定义 Timeline 源 + minimap/overview ruler 着色 + "why" ghost text + 改前快照 `vscode.diff`（数据来自 workspace watcher/git，不依赖 DSH 轨迹）；
- **hover / peek** → tool 参数、prompt 片段、preset 组成；
- **Status bar / Timeline** → 当前会话 / 当前 agent / 当前 effort 常驻；
- **三载体分工**：侧边栏 `WebviewViewProvider`（常驻仪表）、大图 `WebviewPanel`（comfy/网状/散点）、`TreeView`（目录/树）＋ `postMessage` 双向桥。

## 6. extension host ↔ webview 消息契约（草）

- `webview → host`：`runHeadless`、`openPreset`、`focusFile`、`renderGraph(kind)`、`setReducedMotion`；
- `host → webview`：状态快照 `{sessions, presets, trajectory, diffSummary, effortCurves}`，按需增量 push；
- 数据分级：P0/P1 走 headless stdout + 磁盘文件；P2 才走 `/api`（仅读取 `sessions.models` 等，写入动作先不做）。
- **契约二分**：以下消息仅自绘 webview（flavor B）承载；A 壳 iframe 跨源、零 postMessage，其动作走 host 命令/工具条（见 REVIEW-03 §2.1）。

## 7. 风险与未知（评审重点）

1. `/api` RPC + WS 是内部 0.1-rc 契约，升级可能变 → P0/P1 不依赖它。
2. iframe 与 `127.0.0.1:3080` 的同源/信任：webview CSP、`--trusted-host` 语义需验证；是否需要代理转发。
3. `reasoningEffort` 是**会话级选择**（`selectModel` 的 adapter-owned effort），不是模型目录静态字段；preset 文件格式稳定性仍需留意；transcript 落盘格式**已实测**（见 §2.6 与笔记）。
4. 信息密度 ↔ 性能：大会话的轨迹可能极长，需要虚拟化/降采样/分页。
5. headless 输出**已确认**：stdout=最后一段非空 assistant 文本、stderr=终端 error 的 code/message、退出码 0/1、中间轨迹在 `session.jsonl.zstd`——所以 B 桥 stdout 只能当"最终答案"，轨迹可视化必须读磁盘文件。
6. webview origin 过不了 `/api` 信任栅栏（`vscode-webview://` ≠ loopback authority）→ 禁止 webview 直连 `/api`，只能 iframe 同源或 extension host(loopback)。

## 8. 分期（MVP 优先，评审 4 负责拍板边界）

- **P0（单命令单通道，已落地骨架）**：`DSH: Run Selection / File as Headless Task` 命令 + `DSH` OutputChannel + status bar + `dsh` 定位/冒烟/缺失报错 + 进程治理。**不含** iframe/`/api`/轨迹/diff/自动拉起。
- **P1**：preset/skill/模型目录（读 `settings.yaml` 免密）+ 子 agent 配置面板（provider/model/reasoningEffort/prompt 只读）+ iframe 壳（flavor A）+ 文件修改 diff（workspace watcher/git，不依赖 DSH 轨迹）。
- **P2**：会话轨迹时间线/comfy 流 DAG/归因图（复用 connection carrier 读 `session.history`，不裸读 zstd）+ 原生 `/api` 只读观测。

## 9. 技术栈建议（评审 3 可改）

- TypeScript + `@types/vscode`，Node extension host（桌面版）；
- 复用/新写轻量 webview：原生 TS + `d3-force`（网状）+ 图表库（散点折线，如 ECharts 或 uPlot）；
- `child_process` + 磁盘读取为主；P2 才引入 WS 客户端；
- 打包：`esbuild` + `@vscode/vsce`，`package.json` 声明 `viewsContainers`/`views`/`commands`。

## 10. 多 agent 评审/实现流程

- 并行评审四个角色：①架构与 DSH 集成正确性 ②可视化与信息设计 ③VSCode 工程可行性 ④范围/分期/风险；
- 汇总定稿后，按 P0→P1→P2 实现；
- 辅助性大批量任务（翻译、大量用例生成、批量文本处理）拆成独立批量步骤执行。

## 备注（源码依据）

1. `juice` 无字面量字段；`reasoningEffort` 见 `dsh-client-ui-model-selection/lib/client.js`（`selectModel({provider, model, reasoningEffort})`）与 `dsh-agent-loop/lib/index.js`（`adapterDefaults.reasoningEffort`）。
2. agent preset 机制见 `@deepseek-ai/dsh-agent-presets/README.md`：composition（`agent.cordis.yml`）+ 只读显示元数据（`preset.yml`），authoring 仅 copy-only。
3. `/api` 为**复合分发**（Typert 特权子集 + api-proxy 普通 JSON RPC），两条下行 WS；详见 `@deepseek-ai/dsh-api-gateway/README.md` 与 `@deepseek-ai/dsh-host-webserver/README.md`。
4. headless 入口见 `@deepseek-ai/dsh/README.md`（`dsh --profile headless "job"`）。
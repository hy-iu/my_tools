# 可视化与信息设计评审（评审 ②，对 DESIGN.md §4/§5）

> 只给增量判断，不复述原稿。判断均锚定 §2 已核实的数据源。

## 一、七类呈现 × DSH 数据：映射裁决

| # | 模式 | 数据支撑 | 裁决 | 真/伪 |
|---|---|---|---|---|
| 1 | 对话框 | 强（token 流）但与路线 A 的 iframe 壳**功能重叠** | **保留，重定位** | 不重定位即"伪"（重复造 iframe） |
| 2 | 目录 | 强（`<dshHome>/.agent-presets/`、`skills/` 稳定） | **保留** | 真。注：会话清单落盘格式稿中自标"待 P1 实测"（§2.6/§7.3），"会话目录"P1 前为待定项 |
| 3 | 树状 | 半支撑 | **合并** | 真（消息树/派生）；**tool 调用树与 comfy 流重叠（树=DAG 的退化），并入 comfy 流**，避免双份渲染同一份数据 |
| 4 | 网状 | 一半伪一半真 | **拆分** | 见下 |
| 5 | comfy 流 | 部分支撑 | **保留，限定范围** | 真，但仅限真实分叉场景（见下） |
| 6 | 散点-折线 | 多数支撑 | **保留，effort 降级** | 真（token/latency/tool 次数）；effort 曲线 = 半伪 |
| 7 | 动画 | 非独立维度 | **降级为横切原则** | 范畴错误：流式 token / tool 脉冲 / 派生是其他视图的"动效属性"，不是同级呈现模式 |

**第 4 项网状拆分**：
- "代码/论文**实体关系**网" → **砍**。DSH 不是代码索引器也不是引文库，没有实体关系数据源；硬画等于自建 LS/引文解析，与编辑器自身能力重复。**伪需求**。
- "agent↔file↔tool **归因图**" → **保留**。transcript 直接可导出的二部/三部图（哪个 preset 经哪个 tool 碰了哪个文件的哪段）。**真高价值**。把"交互分析代码和论文"从"实体关系"重定义为**provenance/归因**：agent-claim → 文件/PDF span 的边，数据来自 tool call + assistant 文本。

**散点-折线 effort 矛盾**：§3 表写"effort 随会话轨迹画成时间曲线"，§4 写"散点按 effort 着色"——**稿内自相矛盾**。effort 是 per-agent 的离散档位（low/med/high），非连续信号。应作**散点颜色 + 阶跃指示**，不作连续折线。以 §4 着色为准，回改 §3。

**缺失项**：用户诉求"可视化工作内容"，但 §4 七类都是轨迹/agent 视图，文件修改被推到 §5 当"装饰"。建议在 目录/TreeView 增一个"本次会话改动文件清单 + 一句 rationale + diff stat"节点，把"工作内容"显式落成一个视图，而非散落在 diff 里。

## 二、每类：推荐载体 + 关键交互闭环（图→源/diff）

| 模式 | 推荐载体 | 关键闭环 |
|---|---|---|
| 对话框 | sidebar WebviewView（常驻） | 点 assistant 消息中提到的文件 span → 打开 editor 并 gutter 高亮**该消息触发**的改动 hunk + peek 该 turn 的 rationale |
| 目录 | 侧边栏 TreeView（原生懒加载） | 点"改动文件"节点 → `vscode.diff` 前后快照 + 光标落首处 hunk |
| 树状（消息/派生） | TreeView | 点 tool 调用节点 → editor 定位到该 tool 作用的 file:lineRange |
| 网状（归因） | 大图 WebviewPanel（层次/force 布局） | 点 file 节点 → editor 打开 + 该 agent 的改动行 blame 式高亮；点边 → peek 该 turn 的 tool call 与结果 |
| comfy 流（DAG） | 大图 WebviewPanel + minimap | 点节点 → 跳源码；点"写文件"节点 → 跳 diff；边 hover → 输入/输出 peek |
| 散点-折线 | 大图 WebviewPanel（uPlot） | 点某 turn 散点 → 联动其他视图定位该 turn（时间线↔DAG↔transcript 三视图同步） |
| 动画 | 横切 | 与"运行态"绑定：live tool 节点脉冲；非运行态静态色 |

**最关键的欠规范**：原稿只写"点节点跳源码"，没写"跳 diff + 归因 + why"。所有视图应共享一个点击目标契约——任一节点解析为 `{file, lineRange, turn, agent/preset, beforeSnapshot, afterSnapshot}`，editor 以 `vscode.diff` 打开并 gutter 归因。这正是"可视化文件修改"的核心闭环。

## 三、性能策略（万级 tool call）

| 模式 | 策略 |
|---|---|
| 对话框 | 虚拟滚动列表（只渲染可见消息，DOM 回收）；单条消息 token 封顶、长 tool 输出折叠为"可展开"；流式追加到文本节点，不全量重渲 |
| 目录 | 原生 TreeView `getChildren` 懒加载；会话按 mtime 分页，勿全量预载 |
| 树状 | TreeView 懒展开；连续同类 tool 聚合为"ran X ×23"宏节点，可下钻 |
| 网状 | 先按类型聚合出**粗图**（agent/file/tool-type 节点带计数，~10s 节点）；点节点按需展开**邻域子图**（≤50）；禁止 d3-force >500 节点；粗图用层次布局（dagre）预排 |
| comfy 流 | 全图 minimap + 视口矩形（仿 ComfyUI）；按 turn/时间窗分页；重复 tool 模式折叠为宏节点；**线性会话退化为紧凑列表，不渲染完整节点图** |
| 散点-折线 | 用 **uPlot**（canvas 原生密度），**不要 ECharts**；>10k 点用 LTTB / min-max 降采样；tool 次数按 turn 或秒分桶；hover 时从磁盘懒取精确原始值 |
| 动画 | 同时动画节点 ≤50；webview 隐藏时 `visibilitychange` 暂停；reduced-motion 退化为静态色/徽标 |

## 四、文件修改可视化的原生/半原生手段（超出 diff/gutter/内联高亮）

原稿 §5 只有"SCM 式 diff + gutter + 内联高亮"三件套，漏了能让"谁改、为什么改"一眼看懂的高价值手段：

1. **Agent-blame gutter**（最高优先）：仿 git blame，按行归属到 agent/preset + turn，gutter 色块按 agent 着色。直接回答"一个 agent 改了哪些文件"。
2. **CodeLens（符号级聚合）**：每个函数/符号上方挂"modified by agent X · 3 changes · turn N"，点击开 diff + rationale。导航 + 概览双用。
3. **自定义 Timeline 源**：贡献到 VSCode 原生 Timeline 视图，把 agent 改动事件与 git commit 并排。回答"这个文件何时被谁改"。
4. **Minimap / overview ruler 着色**：缩略图按 agent 染色改动块。极廉价、极高密度的"一眼"视图。
5. **"Why" 内联 ghost text**：把每个 edit tool call 与其**前一条 assistant 推理文本**关联，hover 改动行直接 peek"为什么改"。这是"为什么改"的数据落地。
6. **改前快照 → `vscode.diff`**：agent 跑前对涉及文件做内存/磁盘快照，事后用内置 diff 编辑器比前后版本（不靠 git）。

## 五、对 DESIGN.md §4/§5 的具体增删改

**§4 改：**
- 删第 7 行"动画"作为同级模式，改为表下一条横切注记（保留 prefers-reduced-motion）。
- 网状行拆分：删"代码/论文实体关系"映射，仅保留"agent↔file↔tool 归因图"，注明数据来自 transcript 的 tool-call + 文件 diff 关联，非 LS/引文。
- 树状行：删"tool 调用调用树"（并入 comfy 流），仅留"消息树 + 子 agent 父子派生"，并标"派生关系结构化"为 P1 阻塞性验证项。
- comfy 流行：加限定"仅用于 workflow/并行子 agent 等真实分叉场景；线性会话退化为树/列表"。
- 散点-折线性：把"effort 时间曲线"改为"effort 作散点颜色 + 阶跃指示"，加注与 §3 的一致性修正方向。
- 表下新增"共享点击目标契约"：任一节点 → `{file, lineRange, turn, agent, before/after snapshot}` → editor `vscode.diff` + gutter 归因。把"跳源码"升级为"跳 diff + 归因 + why"。
- 目录行补"工作产出"子节点（本次会话改动文件清单 + rationale + diff stat）。

**§5 改：**
- 文件修改项从"三件套"扩为"六件套"：补 agent-blame gutter、CodeLens 符号级、自定义 Timeline 源、minimap/overview ruler 着色、"why" ghost text、改前快照 `vscode.diff`。
- 明确 §4 节点点击 ↔ §5 装饰的联动：点 agent 节点 → editor gutter 自动高亮该 agent 的改动 + CodeLens 聚焦。

## 总评
真高价值的是 目录/归因网/comfy(限定分叉)/散点-折线；对话框须重定位为"关联式 transcript"才不与 iframe 重复；动画应降级为横切原则；最大的两处欠规范是"图→diff+归因+why"的闭环契约、以及文件修改缺 agent-blame/CodeLens/Timeline 三件原生手段——补上这两块，"高信息密度+符合直觉+利用编辑器特性"才真正落地。

# 评审汇总与裁决（V1.1 定稿依据）

> 四份评审：REVIEW-02（可视化/信息设计）、REVIEW-03（VSCode 工程可行性，落盘 `REVIEW-03-VSCode工程可行性.md`）；
> 评审①（架构/DSH 集成）与评审④（范围/分期/风险）结论在本轮会话消息中交付。
> 本文做两件事：①消除评审间事实分歧；②把共识裁决合并成 DESIGN V1.1 的定稿基线。

## 一、事实性分歧处理（一手源码为准）

- **分歧**：评审③称「`--trusted-host` 不存在，整棵源码 grep 不到」；评审①称信任栅栏接受 `--trusted-host` 额外 authority。
- **一手证据**：`@deepseek-ai/dsh-web-app/lib/startup.js:22` 明确
  `.option("--trusted-host <authority...>", "extra authority the /api browser-trust fence accepts (host or host:port; repeatable)")`；
  `lib/index.js:51` `trustedHosts: [...lanAddresses, ...extra]`；`resolveLanTrust(ctx.webServer.host, config.trustedHosts)`；
  `cordis.patch.yml` 与 `lib/types/*.d.ts` 通篇引用 `trustedHosts`。
- **裁决**：`--trusted-host` **真实存在**（可重复、接受 `host[:port]`）；评审③此项为误检（疑似 grep 范围不含嵌套的 `dsh-web-app`）。评审③其余两条事实结论与一手一致，予以采纳。

## 二、阻断级修正（必须改，已并入 DESIGN）

| 编号 | 结论 | 落地 |
|---|---|---|
| S1 | `/api` 是**复合分发**：Typert Gateway 认领 loopback-pinned 特权方法（`host.pickDirectory`/`settings.*`/`credentials.*`/`agentPreset.read/copy/openDocument/remove`），未认领回落到 `dsh-host-apiproxy` 普通 JSON RPC（`session.*`/`agentPreset.list`/`command.*`/`skill.*`）。设计稿引用的 `session.models/selectModel` 属后者。下行两条 WS：`/api/events.mux` + `/api/events.host`。 | 改 §2.3/§6/备注3 |
| S2 | P0「文件修改 diff」无法从 DSH 数据取得（headless stdout 只有最终文本；轨迹 zstd 不可裸读）。diff 数据改走**工作区 FS watcher / git diff / `TextDocumentContentProvider`**，不依赖 DSH 内部。 | 改 §7.5/§8.P0 |

## 三、重要修正（A 级）

- **A1 · `reasoningEffort` 语义**：adapter-owned、**per-model 离散分类**档（非连续标量）；会话级快照、不随轨迹变化；`session.selectModel` 会写**部署默认**（非纯观察）。连续「努力/成本曲线」改用 `dsh-token-meter` 的 per-request token/latency，**不用** `reasoningEffort`。散点-折线里 effort 作「离散颜色 + 阶跃」，不作连续折线。
- **A2 · 会话轨迹读取**：`session.jsonl.zstd`（默认 zstd 帧、packed-chunk codec、v0 无迁移承诺）→ P1 裸读脆弱。轨迹时间线下移到 P2，且优先经 `session.history`（cold read）或复用 `@deepseek-ai/dsh-client-connection` Node carrier，不裸读 Zstd 日志。
- **B1 · webview 过不了 `/api` 信任栅栏**：`vscode-webview://` origin ≠ loopback Host authority → 403；webview 禁止直连 `/api`，只能 iframe 同源或 extension host(loopback)。
- **B3 · `dshHome` 不可硬编码**：实现 `resolveDshHome()`（configured > `$DSH_HOME` > `~/.dsh`）；extension host 内**不要**依赖 `DSH_*` 环境变量（那是 dsh 作父进程时才注入）。

## 四、可视化重排（REVIEW-02 采纳）

- 保留：目录、agent↔file↔tool **归因图**、comfy 流（**限定真实分叉**；线性会话退化为列表）、散点-折线。
- 砍：`代码/论文实体关系网`（伪需求，DSH 无实体关系数据源；"交互分析论文"重定义为**provenance/归因**）。
- 重定位：对话框 →「关联式 transcript」（不与 iframe 重复）；动画 → 横切原则（非第七类）。
- effort：离散色 + 阶跃。
- 文件修改「六件套」：agent-blame gutter、CodeLens 符号级、自定义 Timeline 源、minimap/overview ruler 着色、"why" ghost text、改前快照 `vscode.diff`。
- 共享点击目标契约：任一节点 → `{file, lineRange, turn, agent, before/after snapshot}` → `vscode.diff` + gutter 归因。
- 性能：uPlot（非 ECharts）+ LTTB；归因图先粗图聚合再 ≤50 邻域下钻，禁 force >500；comfy 加 minimap+分页。

## 五、定稿 P0（合并评审④③）

**范围**：单命令单通道——
1. 命令 `DSH: Run Selection / File as Headless Task`（正则用当前选区，否则整文件；>200KB 拒绝并提示）；
2. `DSH` OutputChannel 流式收 stdout/stderr + 退出码；
3. Status-bar 指示 idle/running/error；
4. `dsh` 定位（config `dsh.executablePath` > `DSH_BIN` > 已知路径 > `which`）**+ `--version` 冒烟**；
5. 缺 `dsh` 的 actionable 报错（含跳转设置）；
6. 进程治理：`detached:true` 建组、`process.kill(-pid)` 整组终止、deactivate 兜底全杀。

**明确不做**（P0）：iframe 壳、`/api`、轨迹解析、diff 视图、自动拉起 `dsh web`、动画。路线 A（iframe）与 diff 视图推迟到 P1（diff 走 workspace watcher/git，不含 DSH 内部）。

**验收（可演示）**：①选中文本跑命令出现 OutputChannel 且最终答案落 stdout；②删/改名 `dsh` 后运行给出含设置跳转的报错；③运行中 status bar 转 running、结束转 idle/error；④超大选区被拒绝；⑤重复触发被「已有任务在跑」拦截。

## 六、下一轮动作

1. 按本稿落地 extension.ts 加固（冒烟 + 进程组终止 + 配置项）并重建验证；
2. P1 起：先做 `resolveDshHome()` + 只读模型目录(`settings.yaml`)/presets(`agent.cordis.yml`+`preset.yml`)/skills，再做 iframe 壳（flavor A）与 diff（workspace watcher）；
3. P2：复用 connection carrier 读 `session.history` 等，做轨迹时间线/comfy DAG/归因图 —— 不裸读 zstd。
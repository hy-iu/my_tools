# DSH 面·实测笔记（插件实现的真相源）

> 本笔记记录对 **本机安装的 `@deepseek-ai/dsh@0.1.0-rc.6`** 的实测结论，作为 `dsh-vscode`
> 实现时的数据源契约。字段级信息直接来自本机文件/进程，优先级高于设计稿中的"待确认"。

## 1. CLI 与进程面

- 可执行文件：`/opt/homebrew/bin/dsh` → 符号链接到 `.../node_modules/@deepseek-ai/dsh/lib/bin.js`。`dsh --version` = `0.1.0-rc.6`。
- WebUI：`dsh web`（=`--profile web`）→ HTTP + WS，`DSH_WEB_URL=http://127.0.0.1:3080`。
  - `GET /` → `200 text/html`（SPA；响应头**未观察到** `content-security-policy`）。
  - `POST /api`（裸调用）→ `404`；`/api` 是 Typert Remote RPC，需带正确 endpoint/负载，不是普通 REST。
- Headless：`dsh --profile headless "task"`。语义（源码 `@deepseek-ai/dsh-headless/README.md`）：
  - 建一个全新持久化会话，提交 task 作为普通 user 消息，等待静止（quiescence）；
  - **stdout 只写最后一段非空 assistant 文本**；成功时 **stderr 为空**；terminal `error` 会把 code+message 写到 stderr；
  - 退出码：`turn/end` completed → 0，否则 1；**不开监听端口**；
  - **中间轨迹不在 stdout** → 想看轨迹必须读会话落盘文件（见 §2）。
- 环境变量（bash 工具内可见）：`DSH_HOME=/Users/bjergsen/.dsh`、`DSH_SESSION_ID`、`DSH_SESSION_JSONL`、`DSH_SHELL=1`、`DSH_WEB_URL`。

## 2. 会话轨迹真相源（读文件即可，无需碰 `/api`）

- 布局：`$DSH_HOME/sessions/<mangled-cwd>/<session-id>/session.jsonl.zstd`
  - mangled-cwd：把工作目录的 `/` 换成 `-`，两端再包 `--`，例：`/Users/bjergsen/Documents/GitHub/my_tools` → `--Users-bjergsen-Documents-GitHub-my_tools--`。
  - 每个会话一个目录；**子 agent（subagent）也是同层兄弟目录**（目录名 = 子 agent id）。
- 文件：`session.jsonl.zstd` —— **zstd 压缩的逐行 JSONL**。工具：`zstd -dc` / `unzstd`（本机 `/opt/homebrew/Caskroom/miniforge/base/bin/zstd`）。
- 记录两种：
  - **header**（首条）：`{type:"session", version:"0", id, createdAt, cwd, delegationDepth, agentPreset:"standard"}`。
  - **event**（其余）：`{type, seq, time, data[, surfaceOp]}`。

### 事件词典（一次实测会话的完整 type 集合）

| type | data 关键字段 | 可视化用途 |
|---|---|---|
| `user/message` | `content, source, role, id` | 对话框流 |
| `assistant/message` | `turn, step, message{role,content[]}, usage` | 消息流 + **token 用量**（`usage` → 散点折线） |
| `assistant/chunk` / `text-chunks` | `turn, step, index, dt, texts` | 流式动画（`dt` 为时间差） |
| `reasoning-chunks` | `turn, step, index, dt, texts` | 思考过程时间线 |
| `tool/call` | `turn, step, callId, name, arguments` | **comfy DAG 节点**（工具名=节点；arguments 为参数） |
| `tool-call-chunks` | `turn, step, index, dt, id, name, args` | comfy DAG 的流式参数填充动画 |
| `tool/result` | `turn, step, message{source.callId, content[]}, meta` | comfy DAG 边/结果（callId 关联回 `tool/call`） |
| `turn/start` / `turn/end` | `turn` / `turn, reason` | 轮次边界 |
| `step/start` / `step/end` | `turn, step` | 步骤边界 |
| `request/header` | `header{config{provider,model,maxTokens}, adapterDefaults, system}` | **子 agent 配置可视化**（provider/model/系统提示） |
| `request/context` | `provider, model, contextWindow` | 配置可视化精简视图 |
| `sandbox/mode` | `mode` | 沙箱模式 |
| `approval/policy` | `policy` | 审批策略 |
| `permission/preset` | `preset` | 权限预设 |
| `agent/inbox/spliced` | `target, start, inserted` | **子 agent 派生 / 消息树 / 网状** |
| `goal/change` | `kind, version, operation, goal, roundsStarted, createdAt, updatedAt` | 目标状态 |
| `todo/write` | `todos` | 任务清单 |
| `session/title` | `title, messageSeqs, source` | 会话标题 |
| `web/deepseek-search-llm-request` | `endpoint, apiVersion, body` | 联网检索请求 |

### 关键字段形状（实测样例）

- `request/header.header.config` = `{provider, model, maxTokens}`；`header.adapterDefaults` = `{maxTokens:true}`；`header.system` = 系统提示全文。
- `request/context` = `{provider, model, contextWindow}`（**这就是"供应商/模型"的真相字段**）。
- `tool/call` = `{turn, step, callId:"call_...", name:"web_search", arguments:"{\"query\":\"...\"}"}`（arguments 是 JSON 字符串）。
- `tool/result.message.source` = `{kind:"tool", callId}`；`message.content[].toolCallId` 与 `tool/call.callId` 对应 → comfy DAG 的边。

## 3. 子 agent 配置 / "juice" / 模型目录

- **"juice 值"在 DSH 里无字面字段**；语义对等是“adapter-owned effort”=`reasoningEffort`，在 `sessions.selectModel({provider, model, reasoningEffort})` 时按会话选定（不是模型目录的静态字段）。
- 模型目录真相源 = `~/.dsh/settings.yaml`：
  - `llm-pi-ai.providers.<provider>` 每项含 `apiKeyEnv`（只存环境变量名，不存密钥）、`api`、`baseURL`、`models[]`（`id/name/contextWindow/maxTokens`）。
  - `agent-default-model.provider/model` = 当前默认。
  - **用户点名的模型都真实存在**：`qwen-token-plan-cn.deepseek-v4-flash-0731`、`paratera.*`（含 `DeepSeek-V4-Flash-0731`、`Qwen3.8-Max`）、`meet2ai-gpt.gpt-5.6-sol/.terra`、`meet2ai-claude.claude-fable-5`、`claude-opus-4-8`、`qwen3.8-max-preview` 等。
- 密钥在 `~/.dsh/.credentials.yaml`（经 `apiKeyEnv` 间接引用）——**插件只读模型目录与 `apiKeyEnv` 名称，绝不读 `.credentials.yaml`**。

## 4. 对 DESIGN.md 的结论性修正

1. §2「会话/transcript 落盘格式待确认」→ **已确认**：见 §2 事件词典；可视化 P1/P2 的数据模型可直接按上表落地。
2. §7.5「headless 输出」→ **已确认**：stdout=最后 assistant 文本、stderr=错误、退出码 0/1、轨迹在 session.jsonl.zstd。
3. §7.3「reasoningEffort 语义 / preset 稳定性」→ reasoningEffort 是会话级选择（非静态字段）；模型目录静态字段为 contextWindow/maxTokens。
4. 新增数据源：`~/.dsh/settings.yaml`（模型目录）→ §3 子 agent 配置可视化的 provider/model 真相源。
5. iframe：服务器未下发 CSP 头，路线 A 的阻碍主要是 VSCode webview 侧 CSP 与 `frame-src`（待评审 3 实证）。
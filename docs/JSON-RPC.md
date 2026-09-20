# Codex App Server JSON-RPC

本文说明桌面客户端如何与 **Codex App Server** 通信。协议由上游 `codex app-server` 定义；本仓库用生成的 JSON Schema 作为字段级真相。

产品概念（Project / Thread / Turn / Item）见 [Product.md](./Product.md)。实现见 `apps/codex-work`（Tauri + Rust）。

**接一条新方法的步骤**见 [RPC-WIRE.md](./RPC-WIRE.md)。方法是否已接见 [RPC-INVENTORY.md](./RPC-INVENTORY.md)。产品待办见 [ROADMAP.md](./ROADMAP.md)。

## 1. 传输

```text
客户端（codex-work Rust）
        stdin / stdout，每行一条 JSON（JSONL）
        stderr 为诊断日志，不参与协议
codex app-server --listen stdio://
```

启动示例（本仓库还会用 `-c` 注入 `model` / `model_provider` / `base_url`）：

```bash
codex app-server --listen stdio://
```

约定：

- 一行一条消息，UTF-8，以 `\n` 结束。
- `id` 为 `string` 或 `integer`。
- 报文**不要求** JSON-RPC 2.0 的 `"jsonrpc": "2.0"` 字段；本仓库实现也不写该字段。
- 空行忽略。解析失败的行应丢弃并打日志，不要断开整条管道。

刷新本仓库 schema（字段以这次导出为准）：

```bash
codex app-server generate-json-schema --out apps/codex-work/src-tauri/schemas
```

关键文件：

| 文件 | 内容 |
|------|------|
| `schemas/JSONRPCRequest.json` | 请求（有 `id` + `method`） |
| `schemas/JSONRPCNotification.json` | 通知（只有 `method`） |
| `schemas/JSONRPCResponse.json` | 成功响应（`id` + `result`） |
| `schemas/JSONRPCError.json` | 失败响应（`id` + `error`） |
| `schemas/ClientRequest.json` | 客户端 → 服务端方法全集 |
| `schemas/ClientNotification.json` | 客户端 → 服务端通知 |
| `schemas/ServerNotification.json` | 服务端 → 客户端通知 |
| `schemas/ServerRequest.json` | 服务端 → 客户端请求（需回 `result`） |
| `schemas/v2/*Params.json` / `*Response.json` | 各方法参数与返回值 |

## 2. 消息形态

### 客户端请求

```json
{ "id": 1, "method": "initialize", "params": { } }
```

### 成功 / 失败响应

```json
{ "id": 1, "result": { } }
```

```json
{ "id": 1, "error": { "code": -32603, "message": "..." } }
```

### 通知（任一方，无 `id`，不期待响应）

```json
{ "method": "initialized", "params": {} }
```

```json
{ "method": "item/agentMessage/delta", "params": { "itemId": "...", "delta": "hello" } }
```

### 服务端请求（有 `id`，客户端必须回响应）

典型场景：命令 / 写文件审批。客户端用**同一个 `id`** 回 `result`，不要当成通知。

```json
{ "id": 42, "method": "item/commandExecution/requestApproval", "params": { "threadId": "...", "turnId": "...", "itemId": "...", "command": "ls" } }
```

```json
{ "id": 42, "result": { "decision": "accept" } }
```

分发规则（本仓库 `rpc_client.rs`）：

1. 有 `id` 且有 `result` 或 `error` → 挂起请求的响应。
2. 有 `id` 且有 `method` → ServerRequest。
3. 只有 `method` → Notification。

## 3. 握手

必须先 `initialize`，成功后再发 `initialized`。未完成握手前不要发 `thread/*` / `turn/*`。

**`initialize`（request）**

`params`：

- `clientInfo`（必填）：`name`、`version`，可选 `title`
- `capabilities`（可选）
  - `experimentalApi`：是否接收实验方法/字段
  - `optOutNotificationMethods`：屏蔽指定通知（如 `thread/started`）
  - `requestAttestation`、`mcpServerOpenaiFormElicitation`

本仓库发送：

```json
{
  "id": 1,
  "method": "initialize",
  "params": {
    "clientInfo": { "name": "codex_work", "title": "Codex Work", "version": "<crate>" },
    "capabilities": { "experimentalApi": true }
  }
}
```

`result` 含 `codexHome`、`userAgent`、`platformFamily`、`platformOs`。

**`initialized`（client notification）**

```json
{ "method": "initialized", "params": {} }
```

当前 schema 里客户端通知只有这一个方法。

## 4. 本仓库已实现的主路径

概念映射：UI「会话」= App Server **Thread**（`id` 即会话 id）。**项目**仍由客户端本地维护，是一组 `cwd` 相同的 Thread；没有 `project/*` API。

```text
initialize → initialized
    → thread/list（侧边栏） / thread/read（打开会话） / thread/name/set（改名）
    → thread/start（新对话；有项目用项目 cwd，否则生成随机默认目录）
    → thread/resume + turn/start
    → 通知：turn/started、item/*、turn/completed
    → 如有审批：ServerRequest → { decision }
    → 可选 turn/interrupt
```

### `thread/start`

创建新 Thread。本仓库常用字段：

| 字段 | 本仓库取值 |
|------|------------|
| `cwd` | 必带。有项目用项目目录；未分组则生成 `Documents/Codex/YYYY-MM-DD/<slug>` |
| `approvalPolicy` | 来自 App Server `config.toml` 的 `approval_policy`（默认 `"on-request"`） |
| `sandbox` | 来自 `sandbox_mode`（默认 `"workspace-write"`） |
| `model` | 设置里的模型名（可空） |

`approvalPolicy`：`untrusted` | `on-request` | `never`（另有 `granular` 对象形态）。  
`sandbox`：`read-only` | `workspace-write` | `danger-full-access`。

权限读写走 `config/read` / `config/value/write`（键：`sandbox_mode`、`approval_policy`）。UI 在 composer 下方「权限」控件，预设对齐官方：请求批准 / 自动 / 完全访问。

`result` 里取 `thread.id` 作为后续 `threadId`。

### `thread/resume`

用已有 `threadId` 续上。优先 `threadId`。本仓库：`{ "threadId", "approvalPolicy", "sandbox" }`（值来自当前 config）。

### `turn/start`

必填：`threadId`、`input`。

`input` 为 `UserInput[]`。文本：

```json
{ "type": "text", "text": "用户消息" }
```

还可有 image / localImage / skill / mention。本仓库只发 text。可选 `model`、`cwd`、`approvalPolicy`、`effort` 等覆盖本 turn 及之后。

`result` 里取 `turn.id`。真正开始以通知 `turn/started` 为准。

### `turn/interrupt`

必填：`threadId`、`turnId`。

### 本仓库处理的通知

| 服务端 method | 客户端行为 |
|---------------|------------|
| `turn/started` | 记下 `threadId` / `turn.id`，UI 进入运行中 |
| `turn/completed` | 按 `turn.status` 映射为完成 / 中断 / 失败 |
| `item/agentMessage/delta` | 流式拼助手文本（`itemId` + `delta`） |
| `item/started` / `item/completed` | `agentMessage` 或工具项（`commandExecution` / `fileChange` / `mcpToolCall` / `dynamicToolCall`） |
| `error` | 当 turn 失败 |
| 其它 | 原样转发给前端，便于调试 |

`turn.status` 常见：`completed`、`interrupted`、`failed`。

### 本仓库处理的审批（ServerRequest）

| method | 含义 | 本仓库 UI |
|--------|------|-----------|
| `item/commandExecution/requestApproval` | 跑命令 | `run_command` |
| `item/fileChange/requestApproval` | 改文件 | `write_file` |

其它已知但未实现的 ServerRequest 回 JSON-RPC error `-32601`，避免错误的 `{ "decision": "decline" }` 形状。

审批 `result.decision`（命令审批 schema）：

- `"accept"`
- `"decline"`
- `"acceptForSession"`（本会话同类不再问）
- 以及带 execpolicy 修正的对象形态

本仓库只发 `accept` / `decline`。

## 5. 方法目录

逐方法作用、对接情况、未接可支撑的产品能力见 **[RPC-INVENTORY.md](./RPC-INVENTORY.md)**（补全功能与排期以那份为准）。

下列来自当前 schema。**已接** = `apps/codex-work` Rust 已调用或已专门处理。字段细节看对应 `v2/*` schema。

### 5.1 ClientRequest（客户端 → 服务端，87）

握手

| method | 已接 |
|--------|------|
| `initialize` | 是 |

Thread

| method | 已接 | 说明 |
|--------|------|------|
| `thread/start` | 是 | 新建；带 `sandbox` / `approvalPolicy`（来自 `config/read`） |
| `thread/resume` | 是 | 续聊；同样带权限字段 |
| `thread/fork` | | |
| `thread/archive` / `thread/unarchive` | 是 | 侧栏归档；设置页已归档列表 |
| `thread/delete` | 是 | |
| `thread/unsubscribe` | | |
| `thread/name/set` | 是 | |
| `thread/goal/set` / `get` / `clear` | | |
| `thread/metadata/update` | | |
| `thread/compact/start` | | 压缩上下文 |
| `thread/rollback` | | |
| `thread/list` / `thread/read` | 是 | 列表（`archived` 真/假）；无 `searchTerm` |
| `thread/loaded/list` | | |
| `thread/inject_items` | | |
| `thread/shellCommand` | | |
| `thread/approveGuardianDeniedAction` | | |

Turn / Review

| method | 已接 |
|--------|------|
| `turn/start` | 是 |
| `turn/interrupt` | 是 |
| `turn/steer` | |
| `review/start` | |

Skill / Plugin / Marketplace / App

**`skills/list`**、`skills/extraRoots/set`、**`skills/config/write`**、`hooks/list`、`marketplace/add|remove|upgrade`、**`plugin/list|installed|install|uninstall`**、`plugin/read`、`plugin/skill/read`、`plugin/share/*`、`app/list`

文件系统

**`fs/readFile`**、**`fs/writeFile`**、**`fs/createDirectory`**、**`fs/getMetadata`**、**`fs/readDirectory`**、**`fs/remove`**、**`fs/copy`**、**`fs/watch`**、**`fs/unwatch`**、**`fuzzyFileSearch`**

模型 / 配置 / MCP / 账号

`model/list`、`modelProvider/capabilities/read`、`experimentalFeature/list`、`experimentalFeature/enablement/set`、`permissionProfile/list`、**`config/read`**、**`config/value/write`**、`config/batchWrite`、`configRequirements/read`、`config/mcpServer/reload`、`mcpServerStatus/list`、`mcpServer/oauth/login`、`mcpServer/resource/read`、`mcpServer/tool/call`、`account/*`、`feedback/upload`、`externalAgentConfig/*`

进程 / 沙箱

`command/exec`、`command/exec/write`、`command/exec/terminate`、`command/exec/resize`、`windowsSandbox/setupStart`、`windowsSandbox/readiness`

### 5.2 ClientNotification（客户端 → 服务端）

| method | 已接 |
|--------|------|
| `initialized` | 是 |

### 5.3 ServerNotification（服务端 → 客户端，70）

生命周期：`thread/started`（前端 upsert 侧栏）、`thread/status/changed`（侧栏状态点）、`thread/archived`、`thread/unarchived`、`thread/deleted`、`thread/closed`、`thread/name/updated`、`thread/goal/updated`、`thread/goal/cleared`、`thread/settings/updated`、`thread/tokenUsage/updated`、`thread/compacted`、`thread/environment/connected|disconnected`

Turn：**`turn/started`**、**`turn/completed`**、`turn/diff/updated`、`turn/plan/updated`、`turn/moderationMetadata`

Item：**`item/started`**、**`item/completed`**、**`item/agentMessage/delta`**、`item/plan/delta`、`item/reasoning/summaryTextDelta`、`item/reasoning/summaryPartAdded`、`item/reasoning/textDelta`、`item/commandExecution/outputDelta`、`item/commandExecution/terminalInteraction`、`item/fileChange/outputDelta`、`item/fileChange/patchUpdated`、`item/mcpToolCall/progress`、`item/autoApprovalReview/started|completed`

其它：`error`、`warning`、`guardianWarning`、`deprecationNotice`、`configWarning`、`hook/started|completed`、`process/outputDelta`、`process/exited`、`command/exec/outputDelta`、`serverRequest/resolved`、`skills/changed`、`fs/changed`、`account/*`、`mcpServer/*`、`model/*`、`thread/realtime/*`、`fuzzyFileSearch/sessionUpdated|sessionCompleted`、`windowsSandbox/setupCompleted`、`windows/worldWritableWarning`、`app/list/updated`、`remoteControl/status/changed`、`externalAgentConfig/import/*`

加粗为 Rust 有专门分支；其余会转发到 `codex:event`。前端另外消费了 `thread/started`、`thread/status/changed`、`fs/changed`、`skills/changed`。

### 5.4 ServerRequest（服务端 → 客户端，10）

| method | 已接 | 客户端应回 |
|--------|------|------------|
| `item/commandExecution/requestApproval` | 是 | `{ "decision": "accept" \| "decline" \| ... }` |
| `item/fileChange/requestApproval` | 是 | 同上（见对应 Response schema） |
| `item/permissions/requestApproval` | 否（`-32601`） | |
| `item/tool/requestUserInput` | 否 | |
| `item/tool/call` | 子集（桌面 Dynamic Tools，见 DynamicTools.md） | `{ contentItems, success }` |
| `mcpServer/elicitation/request` | 否 | |
| `account/chatgptAuthTokens/refresh` | 否 | |
| `attestation/generate` | 否 | 需 `capabilities.requestAttestation` |
| `applyPatchApproval` | 否 | 旧形态审批 |
| `execCommandApproval` | 否 | 旧形态审批 |

未处理的 ServerRequest 必须回 `result` 或 `error`，否则服务端会一直挂起。本仓库对未知或未实现的 ServerRequest 回 JSON-RPC error `-32601`。命令/写文件审批使用生成的 Response 类型，目前 UI 只发 `accept` / `decline`。

## 6. 与本仓库代码的对应

| 层 | 位置 |
|----|------|
| 前端 invoke | `apps/codex-work/src/api.ts` |
| Tauri 命令登记 | `src-tauri/src/commands.rs`（`invoke_handler`） |
| 本机能力 | `src-tauri/src/host/`（`settings` / `projects` / `cron` / `dynamic_tools` / `preview` / `store`） |
| 会话编排 | `src-tauri/src/runtime.rs` |
| App Server 实现 | `src-tauri/src/app_server/`（`rpc_client`、`sessions`、`permissions`、`skills`、`plugins`、`items`） |
| 生成的 method 枚举 / 已接 Params | `src-tauri/src/app_server/generated/`（`scripts/generate-rpc-types.py`） |
| 锁定并打包 Codex CLI | `src-tauri/CODEX_VERSION`、`package.json` `@openai/codex`、`scripts/sync-codex-runtime.mjs`、`src-tauri/src/app_server/managed.rs` |

UI 事件名不完全等于协议 method（例如 `turn/started` 会转成前端的 `turn/start`）。以 `runtime.rs` 的 `handle_notification` 为准。

## 7. 维护

- 协议随 Codex CLI 版本变化。本客户端绑定 `src-tauri/CODEX_VERSION`（须与 `package.json` 的 `@openai/codex` 一致）。升级：改这两处 → 用该版本 `generate-json-schema` → `python3 apps/codex-work/scripts/generate-rpc-types.py` → `npm install`。
- 已接线方法的 params 用生成 struct，不要在 `rpc_client.rs` 里手写与 schema 冲突的字段名（驼峰：`threadId`、`turnId`、`itemId`）。
- 接新 ClientRequest 的完整步骤（生成类型 / Tauri / 前端 / 清单）见 **[RPC-WIRE.md](./RPC-WIRE.md)**。
- 接新 ClientRequest 时：把对应 `v2/*Params.json` 加入 `scripts/generate-rpc-types.py` 的 `WIRED_PARAM_SCHEMAS`（复杂 Params），重新生成，再在 `RpcClient` 上增加方法。简单标量 params 可用 `json!({ "threadId": ... })`。
- 本文是导航；具体 required / enum / oneOf 以 schema 为准。

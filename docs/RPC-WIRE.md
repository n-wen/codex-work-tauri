# 如何对接一条 App Server RPC

本文说明在 `apps/codex-work` 里**接上一条协议方法**的固定步骤。协议字段以 schema 为准；产品语义见 [Product.md](./Product.md)；方法是否该做、已做到哪见 [RPC-INVENTORY.md](./RPC-INVENTORY.md)；传输与握手见 [JSON-RPC.md](./JSON-RPC.md)。

先判定这条方法属于哪一类，再按对应清单做。不要跳层：前端不能直连 App Server，必须走 Tauri → Rust → JSONL。

## 1. 先判定类型

| 方向 | 有 `id`？ | 谁发起 | 典型例子 | 本仓库落点 |
|------|---------|--------|----------|------------|
| **ClientRequest** | 有 | 我们 | `thread/archive`、`thread/fork`、`turn/start` | `rpc_client.rs` 的 `RpcClient` 方法 + 业务模块 + Tauri command |
| **ClientNotification** | 无 | 我们 | `initialized` | `RpcClient::notify`（一般不用新接） |
| **ServerNotification** | 无 | App Server | `thread/archived`、`item/agentMessage/delta` | `runtime.rs` `handle_notification` |
| **ServerRequest** | 有 | App Server | `item/commandExecution/requestApproval` | `runtime.rs` `handle_server_request`，**必须**回 `result` 或 `error` |

字段级真相：

```text
apps/codex-work/src-tauri/schemas/v2/<Name>Params.json
apps/codex-work/src-tauri/schemas/v2/<Name>Response.json
apps/codex-work/src-tauri/schemas/v2/<Name>Notification.json   # 仅通知
```

方法名字符串在 `schemas/ClientRequest.json` / `ServerNotification.json` / `ServerRequest.json` 的 `oneOf` 里。Rust 枚举由 `scripts/generate-rpc-types.py` 生成到 `src-tauri/src/app_server/generated/methods.rs`。**方法枚举已经覆盖全集**，接 ClientRequest 时不必改 enum；缺的是 Params struct 和调用代码。

废弃方法（如 `thread/rollback`）不要新做。见清单。

## 2. 全链路（ClientRequest）

用户操作到 App Server 的路径：

```text
UI（Sidebar / SettingsPage / ChatArea）
  → useWorkbench / 其它 hook
  → src/api.ts  invoke('<tauri_cmd>')
  → src-tauri/src/commands.rs  #[tauri::command]
  → app_server/{sessions,permissions} / runtime.rs / host/*
  → app_server/rpc_client.rs  RpcClient::thread_xxx / turn_xxx
  → RpcClient::request / request_typed
  → stdin JSONL  →  Codex App Server
```

返回值原路回来。服务端推送走另一条路：`rpc_client.rs` 读 stdout → `Incoming` → `runtime.rs` → `app.emit("codex:event")` 或 `codex:approval` → 前端 `listen`。

## 3. 对接一条 ClientRequest（最常见）

以「侧边栏归档会话」为例：`thread/archive`。复杂方法（`thread/fork`、`turn/start`）步骤相同，只是 Params 要生成类型。

### 3.1 读 schema

打开 `schemas/v2/ThreadArchiveParams.json`、`ThreadArchiveResponse.json`。

- 线格式字段是 **camelCase**（`threadId`，不是 `thread_id`）。
- `required` 必须传；可选字段 `skip_serializing_if` 或不要塞进 json。
- 有 `oneOf` / 嵌套 enum 的，不要手写 json 猜形状，走 3.2 生成 struct。

### 3.2 要不要生成 Params 类型

`generate-rpc-types.py` 的 `WIRED_PARAM_SCHEMAS` 只覆盖**已经接线**的 Params。新方法二选一：

| 情况 | 做法 |
|------|------|
| 只有 `threadId` 等几个标量 | 可在 `RpcClient` 上用 `json!({ "threadId": thread_id })` + `ClientRequestMethod::ThreadXxx.as_str()` |
| 有 enum、嵌套对象、`oneOf`（sandbox / approval / input） | 把 `v2/XxxParams.json` 加进 `WIRED_PARAM_SCHEMAS`，运行生成脚本，再用 `request_typed` |

生成命令（在仓库根或 `apps/codex-work` 下，保证能读到 `src-tauri/schemas`）：

```bash
python3 apps/codex-work/scripts/generate-rpc-types.py
```

脚本会写 `src-tauri/src/app_server/generated/<module>.rs` 并更新 `mod.rs`。**不要手改 generated 文件。**

生成后挂到 `RpcClient`：

```rust
use crate::app_server::generated::thread_set_name_params::ThreadSetNameParams;
use crate::app_server::generated::ClientRequestMethod;

impl RpcClient {
    pub async fn thread_name_set(&self, thread_id: &str, name: &str) -> Result<Value, String> {
        let params = ThreadSetNameParams {
            thread_id: thread_id.to_string(),
            name: name.to_string(),
        };
        self.request_typed(ClientRequestMethod::ThreadNameSet, &params)
            .await
            .map_err(|e| e.to_string())
    }
}
```

简单方法（归档）：

```rust
impl RpcClient {
    pub async fn thread_archive(&self, thread_id: &str) -> Result<Value, String> {
        self.request(
            ClientRequestMethod::ThreadArchive.as_str(),
            json!({ "threadId": thread_id }),
        )
        .await
        .map_err(|e| e.to_string())
    }
}
```

`request_typed` 会 `serde` 成 Value 再发出；生成 struct 上已有 `#[serde(rename = "threadId")]`。

### 3.3 业务层

按领域放，不要把 JSON-RPC 细节堆进 `commands.rs`：

| 领域 | 文件 |
|------|------|
| Thread 列表 / 读写 / 归档删除改名 | `app_server/sessions.rs` |
| 权限读写 | `app_server/permissions.rs` |
| Skills / 插件 | `app_server/skills.rs`、`app_server/plugins.rs` |
| 文件系统 / 模糊搜索 | `app_server/fs.rs` |
| 一轮对话的 start / interrupt / 审批 | `runtime.rs` |
| 桌面 Dynamic Tools | `host/dynamic_tools.rs` |
| 项目分组（本地，不是 App Server Thread） | `host/projects.rs` |
| 定时任务 / 设置 / 预览 | `host/cron.rs`、`host/settings.rs`、`host/preview.rs` |

App Server 实现的能力直接放在 `app_server/`（`archive_session` 等）。Host 实现的能力放在 `host/`。列表过滤（`archived: false`）要和产品一致：归档后默认列表必须看不到。

### 3.4 Tauri command

1. 在 `commands.rs` 写 `#[tauri::command]`（invoke 名 = 函数名），并加进同文件的 `invoke_handler`。`lib.rs` 只调用这一处。未登记则前端 invoke 报 command not found。
2. command 只转发到 `AppState` 里的服务（如 `state.sessions.archive`）。领域逻辑不放在 command 里。
3. 需要 App Server 连接时由服务内部 `runtime.connected_client`。
4. 参数用 **camelCase 的 TS 对象**，Rust 侧字段 **snake_case**（Tauri 默认 remap）：

```rust
// commands.rs
#[tauri::command]
async fn archive_session_cmd(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state.sessions.archive(app, &session_id).await
}
```

前端：

```ts
invoke<void>('archive_session_cmd', { sessionId })
```

错误用 `Result<T, String>` 即可，前端 `catch` 得到字符串。不要在 command 里再包一层无关的 JSON-RPC。

### 3.5 前端

1. `src/types/index.ts` 的 `CodexApi` 加方法。
2. `src/api.ts` 的 `codexApi` 实现。
3. `useWorkbench.ts`（或设置页自己的 state）编排：调 API、更新列表、若删的是当前会话则清空主区。
4. UI 入口（侧边栏菜单、设置页按钮）。破坏性操作要确认。

本产品里 **Session.id 就是 App Server `threadId`**。`rename_session_cmd` 的 `project_id` 有的是历史兼容，新接口可以只传 `sessionId`。

### 3.6 收尾

- `cargo check`（`apps/codex-work/src-tauri`）
- 前端 `tsc --noEmit`
- 更新 [RPC-INVENTORY.md](./RPC-INVENTORY.md) 该行的「对接」列（未接 → 已接 / 子集）
- 若 JSON-RPC.md 第五节总表仍写「未接」，一并改掉

## 4. 对接一条 ServerNotification

仅当 UI 或运行时状态必须跟着变，才加专用分支。否则 `runtime.rs` 会把已知 method **透传** `codex:event`，前端不听等于没接。

步骤：

1. 读 `schemas/v2/<Name>Notification.json`，确认 `params`（常见顶层 `threadId`）。
2. 枚举已在 `ServerNotificationMethod`，用 `from_method`。
3. 在 `handle_notification` 增加 `Some(ServerNotificationMethod::ThreadArchived) => { ... }`。
4. 需要改 Rust 状态（running、active_turn）的在这里改；需要刷列表的可以 `emit` 后让前端 `refresh`，或 Rust 侧不存会话列表、交给下次 `thread/list`。
5. 若前端要专用 UI：在 `useWorkbench` 的 `onEvent` 里认 method。注意 **UI 事件名可以不等于协议名**（`turn/started` → `turn/start`）。新事件尽量与协议 method 一致，避免再发明一层。
6. 高频 delta（`item/agentMessage/delta`）不要每次全量 `thread/read`。

接 ClientRequest 后，对应通知（`thread/archived`、`thread/deleted`）可以先不接：用户操作返回后再 `list_all_sessions` 也能收敛。专用通知是为了**别的窗口 / 外部归档**时侧边栏自动更新。

## 5. 对接一条 ServerRequest（审批类）

这不是「我们调它」，是 **App Server 问我们，必须回答**。

1. 读 Params + **Response** schema（决策字面量在 Response 里）。
2. 把 Response schema 加入 `WIRED_RESPONSE_SCHEMAS`，生成后 `respond_typed`。`item/tool/call` 用 `DynamicToolCallResponse`（`{ contentItems, success }`），不要回审批的 `{ decision }`。
3. `handle_server_request` 按 `ServerRequestMethod` 分支：弹 UI（`codex:approval`）或立即回。
4. 未实现的方法回 JSON-RPC `-32601`，**不要**用命令审批的 `{ "decision": "decline" }` 去回其它方法。
5. 前端 `respondApproval` 必须带上服务端给的 `id`（本仓库封装在 `requestId`）。

## 6. 命名与字段约定

| 层 | 约定 |
|----|------|
| JSON-RPC method | `thread/archive`（斜杠，与 schema enum 完全一致） |
| 线 JSON 字段 | `threadId`、`turnId`、`itemId`、`nextCursor` |
| 生成 Rust | `thread_id` + `#[serde(rename = "threadId")]` |
| Tauri 命令 | `archive_session_cmd` |
| TS invoke 名 | 与 Rust 命令字符串相同 |
| TS 参数对象 | `{ sessionId }` → Rust `session_id` |

不要在 `rpc_client.rs` 里写 `thread_id` 当 JSON 键。

## 7. 检查清单（复制用）

ClientRequest：

- [ ] 读 Params / Response schema；确认不是废弃方法
- [ ] 复杂 Params：加入 `WIRED_PARAM_SCHEMAS` 并重新生成
- [ ] `RpcClient` 增加方法，`eprintln` 打 method + 关键 id
- [ ] 业务模块包装（校验空 id、更新本地状态）
- [ ] `commands.rs` 增加 command 并登记 `invoke_handler`
- [ ] `types` + `api.ts` + hook + UI
- [ ] 列表过滤 / 当前会话被删或归档时的 UI 收敛
- [ ] 更新 RPC-INVENTORY

ServerNotification：

- [ ] 读 Notification schema
- [ ] `handle_notification` 专用分支或确认透传即可
- [ ] 前端是否要听 `codex:event`

ServerRequest：

- [ ] 生成 Response 类型
- [ ] 永远回复同一 `id`
- [ ] 未实现走 `-32601`

## 8. 实例对照

| 方法 | 类型 | 本仓库参考 |
|------|------|------------|
| `thread/name/set` | ClientRequest + 生成 Params | `RpcClient::thread_name_set` → `Sessions::rename` → `commands.rs` `rename_session_cmd` |
| `thread/archive` `unarchive` `delete` | ClientRequest + 手写 json | `thread_archive` 等；设置页已归档列表 |
| `thread/list` | ClientRequest + 生成 Params | `thread_list_page(..., archived)`；侧边栏 `false`，设置页 `true` |
| `turn/start` | ClientRequest + 大 Params | `runtime.rs`；前端 `startTurn` |
| `item/agentMessage/delta` | ServerNotification | `runtime.rs` 专用 + 前端流式拼接 |
| `item/commandExecution/requestApproval` | ServerRequest | `runtime.rs` + `ApprovalDialog` |

下一步优先方法见 [ROADMAP.md](./ROADMAP.md) 与 [RPC-INVENTORY.md](./RPC-INVENTORY.md)（当前建议 `thread/fork`）。接 `fork` 时走完整生成 Params，并处理返回的新 `thread.id`：创建侧边栏会话并打开，而不是改原会话。

# Codex App Server RPC 方法清单

本文对照当前仓库导出的 schema（`apps/codex-work/src-tauri/schemas`）与 `apps/codex-work` 实现，逐个列出 JSON-RPC 方法：作用、是否对接、对接了什么、未对接可支撑什么产品能力。

用途：后续补全功能与排期。协议字段以 schema 为准；升级 CLI 后重新 `generate-json-schema` 再核对本表。产品待办见 [ROADMAP.md](./ROADMAP.md)。

相关文档：[JSON-RPC.md](./JSON-RPC.md)（传输与握手）、[RPC-WIRE.md](./RPC-WIRE.md)（如何对接一条方法）、[Product.md](./Product.md)（产品概念）。

**统计（当前 schema，对照 `apps/codex-work` 实现）**

| 方向 | 数量 | 已接（专用 / 子集） | 透传 / 未实现 | 未调用 |
|------|------|----------------------|-----------------|--------|
| ClientRequest | 87 | 29 | 0 | 58 |
| ClientNotification | 1 | 1 | 0 | 0 |
| ServerNotification | 70 | 5 专用 + 若干 item 子类型；`thread/started` / `thread/status/changed` / `fs/changed` / `skills/changed` 前端已消费 | 其余转发 `codex:event`，前端未消费 | — |
| ServerRequest | 10 | 6（三条审批 + `item/tool/call` 子集 + `requestUserInput` + MCP elicitation） | 4 回 JSON-RPC `-32601`（账号/attestation/legacy） | — |

已完成、不再排进 P0/P1/桌面波次/P2 的：归档 / 取消归档 / 删除 Thread；文件树 / `fs/*` / `fuzzyFileSearch`；Skills 列表与开关、插件安装与 scheduled 模板；chat + cron 排队；桌面 Dynamic Tools（`cron`、`preview`、`desktop`）；`onceAt` / 开机启动；会话目标 / 压缩 / Review / 集成终端。明确非目标见 [ROADMAP.md](./ROADMAP.md)。

**对接等级**

| 等级 | 含义 |
|------|------|
| 已接 | Rust 主动调用，且 UI / 会话编排用到返回值 |
| 子集 | 已调用，但只传/只用部分字段 |
| 专用 | 服务端通知有 `match` 分支，会改运行状态或映射成前端事件 |
| 透传 | `runtime.rs` 对已知但无专用逻辑的 `ServerNotificationMethod` 原样 `emit("codex:event")`，`useWorkbench` 不处理 |
| JSON-RPC 错误 | 已知但未实现、或未知的 ServerRequest 回 `-32601` |
| 未接 | 客户端从未调用该方法 |

前端实际消费的事件：`thread/started`、`thread/status/changed`、`turn/start`、`item/agentMessage/delta`、`item/agentMessage/completed`、`item/toolCall`、`item/toolCall/updated`、`turn/completed`、`turn/interrupted`、`turn/error`、`codex:approval`、`fs/changed`（文件树刷新）、`skills/changed`（插件页重拉 Skills）。其余协议 method 即使转发到前端也等于没接 UI。

代码锚点：`src-tauri/src/app_server/`（`generated/`、`rpc_client.rs`、`sessions.rs`、`permissions.rs`、`fs.rs`）、`runtime.rs`、`src/api.ts`、`src/hooks/useWorkbench.ts`、`src/components/FilesPanel.tsx`。

---

## 建议排期（对照 Product.md）

按产品目标排序，不是按 schema 顺序。

| 波次 | 目标 | 优先方法 | 现状 |
|------|------|----------|------|
| P0 会话管理 | 分叉 / 搜索 | `thread/fork`；`thread/list` 补 `searchTerm` | fork / `searchTerm` **已接**；归档 / 删除 / `archived` 列表 **已接** |
| P0 对话体验 | 中途插话、图片、reasoning、命令流、diff | `turn/steer`；`turn/start` 的 `image`/`localImage`；`item/reasoning/*`；`item/commandExecution/outputDelta`；`turn/diff/updated` `item/fileChange/patchUpdated` | **已接** |
| P0 审批补全 | 权限升级、本会话记住、取消整轮 | `item/permissions/requestApproval`；`acceptForSession` / `cancel`；不要对非审批方法回 `decision` | **已接** |
| P1 配置与模型 | 自建网关：多模型会话选；多 Provider 在设置里切并重启 App Server | 本地 `providers[]` + 当前套 `models[]`；`thread`/`turn` 传 `model`；切网关走设置并重 `connect` | **已接**（providers + 会话 model；切网关重连） |
| P1 MCP | Product 次要目标：先做配置+列表 | `config` 写 MCP；`mcpServerStatus/list`（含 tools）；reload；OAuth / elicitation 挂在列表上 | **已接**（设置 MCP 页 + OAuth + elicitation） |
| P1 Git | 标题栏仓库状态 | 本机 `git status`（不强制 `thread/metadata/update`） | **已接**（ChatArea Git 状态条） |
| P2 终端 | 独立沙箱终端 | `command/exec*` + `command/exec/outputDelta` | **已接**（ChatArea 集成终端） |
| P2 压缩 / Review | 长会话与代码审阅 | `thread/compact/start`；`review/start` | **已接** |
| P3 Product 加深 | Git 工作区 diff / 提交；首选编辑器；Review 其它 target；MCP resource/tool；通知加深；权限档案 / batchWrite | **已接**（见 [ROADMAP.md](./ROADMAP.md) P3） |
| 低优先级 / 可跳过 | 官方账号、Windows 沙箱、Realtime 语音、legacy 审批 | `account/*`（本产品用自建网关）；`windowsSandbox/*`；`thread/realtime/*`；`applyPatchApproval` `execCommandApproval`；**已废弃** `thread/rollback` | 明确非目标或后置 |

---

## 1. ClientRequest（客户端 → 服务端）

### 1.1 握手

| method | 作用 | 对接 | 当前对接了什么 | 未接可用于 |
|--------|------|------|----------------|------------|
| `initialize` | 握手；声明客户端与 capabilities | **子集** | `clientInfo.name/title/version`；`capabilities.experimentalApi=true`。用 `result` 仅打日志 | `optOutNotificationMethods` 降噪；`requestAttestation`；读 `codexHome` / `platformOs` 做路径与诊断 |

### 1.2 Thread

| method | 作用 | 对接 | 当前对接了什么 | 未接可用于 |
|--------|------|------|----------------|------------|
| `thread/start` | 新建 Thread | **子集** | `cwd`（项目目录或 `Documents/Codex/日期/slug`）、`sandbox`、`approvalPolicy`、可选 `model`。取 `thread.id` | `ephemeral`、`baseInstructions`、`personality`、`modelProvider`、`sessionStartSource` |
| `thread/resume` | 按 `threadId`（或历史/路径）载入并继续 | **子集** | 每次 `start_turn` 先 resume；带当前 `sandbox`/`approvalPolicy` | 按 path/history resume；覆盖 `cwd`/`model` |
| `thread/fork` | 从某 Thread（或路径）分叉新 Thread，可选 `lastTurnId` | **已接** | 侧栏「从这里分叉」；消息「从此处分叉」传 `lastTurnId`；新 `thread.id` upsert 并打开；fork 注入 `dynamicTools` | 路径 fork |
| `thread/archive` | 归档 | **已接** | 侧栏归档；`thread/list archived:false` 不再列出；外部归档靠 `thread/archived` 通知 | — |
| `thread/unarchive` | 取消归档 | **已接** | 设置页「已归档的聊天」恢复；外部取消归档靠 `thread/unarchived` | — |
| `thread/delete` | 删除 Thread | **已接** | 侧栏 / 归档列表删除会调 App Server `thread/delete`；外部删除靠 `thread/deleted` | 删项目仍只是本地分组，不会批量删 Thread |
| `thread/unsubscribe` | 取消订阅该 Thread 的通知 | 未接 | — | 切走会话后少收事件；多 Thread 并行时控流量 |
| `thread/name/set` | 改名 | **已接** | 创建时可设；`renameSession` | — |
| `thread/goal/set` | 给 Thread 设目标（objective / status / tokenBudget） | **已接** | 会话顶目标条设置 | — |
| `thread/goal/get` | 读目标 | **已接** | 打开会话时拉取并展示 | — |
| `thread/goal/clear` | 清目标 | **已接** | 目标条「清除」 | — |
| `thread/metadata/update` | 更新 gitInfo 等元数据 | 未接 | Git 状态条走本机 `git`（含 diff/commit） | 可选回写 App Server 元数据 |
| `thread/compact/start` | 压缩上下文 | **已接** | ChatArea「压缩」按钮 | — |
| `thread/shellCommand` | 在 Thread 语境下跑一条 shell | 未接 | Agent 命令走 turn 内 `commandExecution` | 会话内快捷终端、用户手动跑命令并进历史 |
| `thread/approveGuardianDeniedAction` | 用户批准 Guardian 拦下的动作 | 未接 | 警告 toast 已展示 guardianWarning | Guardian 拦截后的「仍要执行」 |
| `thread/rollback` | **已废弃，即将删除** | 未接 | — | **不要新做**；历史回退改用 fork + `lastTurnId` 或产品层截断展示 |
| `thread/list` | 分页列 Thread | **子集** | 分页；侧栏 `archived:false`，设置页 `archived:true`；`sortKey=recency_at`；侧栏搜索传 `searchTerm` 并 upsert。项目过滤靠本地 cwd 匹配 | 按 `cwd`、`sourceKinds` |
| `thread/loaded/list` | 当前进程已加载的 Thread | 未接 | — | 调试「内存中的会话」；多窗口共享 server 时 |
| `thread/read` | 读 Thread 元数据；分页 store 上勿 `includeTurns:true` | **已接** | 打开会话只读元数据，不灌全量 turns | 旧 store 无分页时才回退 `includeTurns` |
| `thread/turns/list` | 分页列 turns（`itemsView` full/summary/notLoaded） | **已接** | 打开会话拉历史；`itemsView=full` | 按需 summary、从尾部分页 |
| `thread/items/list` | 分页列某 turn 的 items | **已接** | `itemsView` 非 full 或缺 items 时补全 | 增量同步 |
| `thread/inject_items` | 不发用户 Turn，把 Responses API items 追加进历史 | 未接 | — | 导入外部对话、系统注入上下文、迁移 |

### 1.3 Turn / Review

| method | 作用 | 对接 | 当前对接了什么 | 未接可用于 |
|--------|------|------|----------------|------------|
| `turn/start` | 开始一轮；必填 `threadId`+`input` | **子集** | `{type:text}` + `localImage`；可选 `skill`/`mention`、`effort`；另传 `approvalPolicy`、`sandboxPolicy`、可选 `model`。取 `turn.id`（真正开始看通知） | `image` URL；`summary`；`cwd`；`outputSchema`；`clientUserMessageId` |
| `turn/interrupt` | 中断指定 Turn | **已接** | 按 `active_turn` 发 interrupt | — |
| `turn/steer` | 在期望的 `expectedTurnId` 上插入新 input（跑着也能加话） | **已接** | Composer 运行中再发送 → `turn/steer`；无 active turn / 跨会话 busy 时仍入 chat 队列 | — |
| `review/start` | 对 `target` 发起 Review | **已接** | ChatArea / Git popover：`uncommittedChanges` / `baseBranch` / `commit` / `custom`；`delivery` inline|detached | — |

### 1.4 Skill / Plugin / Marketplace / App

Product 次要目标含 Skills；插件是官方 Codex App 侧栏能力。

| method | 作用 | 对接 | 当前对接了什么 | 未接可用于 |
|--------|------|------|----------------|------------|
| `skills/list` | 列可用 Skills（可 `cwds`、`forceReload`） | **已接** | 侧栏「插件」页 Skills 列表 | Composer `@` / Skill 选择器 |
| `skills/extraRoots/set` | 额外 Skill 根目录 | 未接 | — | 企业内置 Skill 路径 |
| `skills/config/write` | 启用/禁用某个 Skill | **已接** | 侧栏「插件」页开关 | — |
| `hooks/list` | 列 hooks | 未接 | — | 展示/调试生命周期钩子 |
| `marketplace/add` | 添加 marketplace 源 | 未接 | — | 插件市场源管理 |
| `marketplace/remove` | 移除源 | 未接 | — | 同上 |
| `marketplace/upgrade` | 升级 marketplace | 未接 | — | 更新插件源 |
| `plugin/list` | 列可安装插件 | **已接** | 与 `plugin/installed` 合并展示 | — |
| `plugin/installed` | 已安装插件 | **已接** | 同上 | — |
| `plugin/read` | 读插件清单 | **已接** | 插件页加载 `scheduledTasks`；「添加到已安排」 | 插件详情页 |
| `plugin/skill/read` | 读插件内 Skill | 未接 | — | 远程/市场 Skill 预览 |
| `plugin/install` / `plugin/uninstall` | 安装/卸载 | **已接** | 侧栏「插件」页安装/卸载 | — |
| `plugin/share/save` | 把插件分享到远端 | 未接 | — | 团队分享插件；私有部署可后置 |
| `plugin/share/updateTargets` | 改分享对象/可见性 | 未接 | — | 同上 |
| `plugin/share/list` | 列已分享插件 | 未接 | — | 同上 |
| `plugin/share/checkout` | 检出远端分享的插件 | 未接 | — | 同上 |
| `plugin/share/delete` | 删除远端分享 | 未接 | — | 同上 |
| `app/list` | 列 apps/connectors（实验，可 `threadId`） | 未接 | — | 连接器/应用列表 |

### 1.5 文件系统

App Server 代读主机文件（受沙箱约束）。产品「文件树 / 打开文件」可走这里，不必自己再实现一套 FS RPC。

| method | 作用 | 对接 | 当前对接了什么 | 未接可用于 |
|--------|------|------|----------------|------------|
| `fs/readFile` | 读文件 | **已接** | 文件面板点开预览（UTF-8 文本 / 二进制提示） | 把文件塞进对话上下文 |
| `fs/writeFile` | 写文件（base64） | **已接** | Tauri API 已暴露；写操作走 base64 | 编辑器内保存 UI |
| `fs/createDirectory` | 建目录 | **已接** | 文件面板「新建文件夹」 | — |
| `fs/getMetadata` | 元数据 | **已接** | 新建目录时判断选中项是否目录 | 文件信息面板 |
| `fs/readDirectory` | 列直接子项 | **已接** | 文件树懒加载展开 | — |
| `fs/remove` | 删文件/树 | **已接** | 文件面板删除（确认框） | — |
| `fs/copy` | 复制 | **已接** | 文件面板「复制/另存」 | — |
| `fs/watch` | 监视路径，配合 `fs/changed` | **已接** | 打开文件面板时监视项目根 | — |
| `fs/unwatch` | 停止监视 | **已接** | 关闭面板 / 切换项目时清理 | — |

### 1.6 模型 / 配置 / 实验特性 / 权限档案

| method | 作用 | 对接 | 当前对接了什么 | 未接可用于 |
|--------|------|------|----------------|------------|
| `model/list` | 列模型（可含 hidden） | **子集** | 用于解析当前模型的 `inputModalities` / `supportedReasoningEfforts`；不替代本地 models 配置 | 可选：添加模型表单建议 |
| `modelProvider/capabilities/read` | 当前 provider 能力 | **已接** | 启动/切网关后读；Composer 按 `inputImages` + effort 列表显隐控件 | — |
| `experimentalFeature/list` | 列实验功能 | **已接** | 设置 App Server 页 | — |
| `experimentalFeature/enablement/set` | 开关实验功能 | **已接** | 同上 | — |
| `permissionProfile/list` | 权限档案列表 | **已接** | 设置 App Server 页；选用写 `default_permissions` | — |
| `config/read` | 读合并后的 config | **已接** | 设置 App Server 页；取 `model` / `model_reasoning_effort` + 可展开 JSON | MCP 细编辑见 MCP 页 |
| `config/value/write` | 写单个 keyPath | **已接** | `sandbox_mode` / `approval_policy`；另允许 `model_reasoning_effort` / `model` / `personality` / `web_search` / `mcp_servers.*` / `default_permissions` | `expectedVersion` 防覆盖 |
| `config/batchWrite` | 批量改 | **已接** | 权限预设一次写 sandbox + approval | — |
| `configRequirements/read` | 运行前缺项 | **已接** | 设置页顶部缺项提示 | — |

### 1.7 MCP

| method | 作用 | 对接 | 当前对接了什么 | 未接可用于 |
|--------|------|------|----------------|------------|
| `mcpServerStatus/list` | MCP 服务器状态 | **已接** | 设置 MCP 页；展示 tools / authStatus | — |
| `config/mcpServer/reload` | 重载 MCP 配置 | **已接** | 保存/删除后调用 | — |
| `mcpServer/oauth/login` | MCP OAuth | **已接** | 列表行 `notLoggedIn` 时打开 authorizationUrl | — |
| `mcpServer/elicitation/request` | MCP 填表/URL | **已接** | UI 对话框回 `accept`/`decline`/`cancel` | form content 细填可后置 |
| `mcpServer/resource/read` | 读 MCP resource | **已接** | 设置 MCP 页只读预览 | 把内容挂进对话可后置 |
| `mcpServer/tool/call` | 客户端主动调 MCP 工具 | **已接** | 设置 MCP 页手动调用（需 threadId） | — |

### 1.8 账号 / Feedback

本产品目标是私有网关、不强制 OpenAI 账号（Product §3 / §8）。这些方法服务官方 ChatGPT 登录与额度。

| method | 作用 | 对接 | 当前对接了什么 | 未接可用于 |
|--------|------|------|----------------|------------|
| `account/read` | 当前账号 | 未接 | 凭证在本地 settings `apiKey` | 若以后支持 ChatGPT 登录 |
| `account/login/start` | 开始官方登录 | 未接 | — | 官方登录；与「自建 baseUrl」路线冲突，建议保持可选 |
| `account/login/cancel` | 取消登录 | 未接 | — | 同上 |
| `account/logout` | 登出 | 未接 | — | 同上 |
| `account/rateLimits/read` | 读限额 | 未接 | — | 官方额度条 |
| `account/usage/read` | 读用量 | 未接 | — | 官方用量 |
| `account/rateLimitResetCredit/consume` | 消耗重置额度 | 未接 | — | 官方额度产品 |
| `account/workspaceMessages/read` | 工作区消息 | 未接 | — | 官方 workspace 通知 |
| `account/sendAddCreditsNudgeEmail` | 催充值邮件 | 未接 | — | 官方商业功能，可忽略 |
| `feedback/upload` | 上传反馈/日志 | 未接 | — | 「发送诊断」 |

### 1.9 进程 / 沙箱 / 搜索 / 外部配置迁移

| method | 作用 | 对接 | 当前对接了什么 | 未接可用于 |
|--------|------|------|----------------|------------|
| `command/exec` | **不**建 Thread，在沙箱里跑独立命令（可 PTY） | **已接** | ChatArea 集成终端（tty + stream） | — |
| `command/exec/write` | 向该进程写 stdin / 关闭 stdin | **已接** | 终端输入 | — |
| `command/exec/terminate` | 按 `processId` 杀进程 | **已接** | 终端「终止」 | — |
| `command/exec/resize` | PTY 尺寸 | **已接** | RpcClient / command 已接（UI 可选） | — |
| `windowsSandbox/setupStart` | Windows 沙箱安装 | 未接 | — | 仅 Windows |
| `windowsSandbox/readiness` | Windows 沙箱是否就绪 | 未接 | — | 仅 Windows |
| `fuzzyFileSearch` | 模糊搜文件（会话式，有进度通知） | **已接** | 文件面板搜索框；用响应 `files`；进度通知仍透传 | Composer `@文件` 可复用 |
| `externalAgentConfig/detect` | 探测其它 Agent 配置（Claude 等） | 未接 | — | 「从 Cursor/Claude 导入配置」 |
| `externalAgentConfig/import` | 执行导入 | 未接 | — | 迁移向导 |
| `externalAgentConfig/import/readHistories` | 读可导入历史 | 未接 | — | 导入历史会话 |

---

## 2. ClientNotification

| method | 作用 | 对接 | 当前对接了什么 | 未接可用于 |
|--------|------|------|----------------|------------|
| `initialized` | initialize 成功后必须发，schema 里客户端通知仅此一个 | **已接** | `notify("initialized", {})` | — |

---

## 3. ServerNotification（服务端 → 客户端）

未单独列出的 method：Rust `other` → `codex:event`，前端忽略。要做 UI 必须在 `handle_notification` 和 `useWorkbench` 加分支。

### 3.1 Turn / Item（主对话路径）

| method | 作用 | 对接 | 当前对接了什么 | 未接可用于 |
|--------|------|------|----------------|------------|
| `turn/started` | Turn 真正开始 | **专用** | 记 `active_turn`、`running=true`；前端事件改名为 `turn/start` | `projectId` 等字段目前原样塞进 JSON，前端未用 |
| `turn/completed` | 结束；`turn.status`：completed / interrupted / failed | **专用** | 映射 `turn/completed` / `interrupted` / `error` | 展示 token、失败详情结构 |
| `item/agentMessage/delta` | 助手文本流式 | **专用** | 拼 `itemId`+`delta`；前端当 `messageId` | — |
| `item/started` | 新 Item | **专用（部分 type）** | `agentMessage`；工具项 → `item/toolCall`；`reasoning`/`plan` → 折叠卡 | compaction 等 |
| `item/completed` | Item 完成 | 同上 | 工具项 `item/toolCall/updated`；agent 最终文本；reasoning/plan 同步 | 同上 |
| `error` | 服务端错误 | **专用** | 当 `turn/error` | 与 turn failed 去重 |
| `item/commandExecution/outputDelta` | 命令 stdout/stderr 流 | **已接** | 按 `itemId` 拼到 `run_command` 工具卡 `result`，运行中自动展开 | — |
| `item/commandExecution/terminalInteraction` | 命令的 TTY 交互 | 透传 | — | 给运行中命令回车/键 |
| `item/fileChange/outputDelta` | **废弃** apply_patch 输出流 | 透传 | — | 忽略，用 patchUpdated |
| `item/fileChange/patchUpdated` | 补丁内容更新 | **已接** | 更新 `write_file` 工具卡 `diffSummary` | — |
| `item/mcpToolCall/progress` | MCP 进度 | 透传 | — | 长 MCP 调用进度条 |
| `item/plan/delta` | 计划流式（实验） | 透传 | — | Plan 面板 |
| `item/reasoning/summaryTextDelta` | reasoning 摘要流 | **已接** | 拼到思考折叠卡 | — |
| `item/reasoning/summaryPartAdded` | 摘要段落 | 透传 | — | 可并入摘要卡 |
| `item/reasoning/textDelta` | reasoning 原文流 | 透传 | — | 调试/高努力模式 |
| `item/autoApprovalReview/started` | 自动审批审查开始 | 透传 | — | 「正在自动评估风险」 |
| `item/autoApprovalReview/completed` | 自动审批审查结束 | 透传 | — | 同上 |
| `turn/diff/updated` | 本轮累计 diff | **已接** | 会话底部「本轮变更」折叠卡 | — |
| `turn/plan/updated` | 计划快照 | **已接** | 计划折叠卡步骤列表 | — |
| `turn/moderationMetadata` | 审核元数据 | 透传 | — | 企业内容安全提示 |
| `serverRequest/resolved` | 某次 ServerRequest 已解决 | **已接** | 关掉本窗审批 / elicitation / toolUserInput | — |

### 3.2 Thread 生命周期

| method | 作用 | 对接 | 当前对接了什么 | 未接可用于 |
|--------|------|------|----------------|------------|
| `thread/started` | Thread 创建 | **已接** | 前端 upsert 侧边栏会话（不必等 `turn/completed` / `thread/list`） | — |
| `thread/status/changed` | 状态 | **已接** | 侧边栏状态点：运行中 / 待审批 / 等待输入 / 出错 | — |
| `thread/archived` | 已归档 | **已接** | 前端从侧栏移除；当前会话被归档则切走 | — |
| `thread/unarchived` | 已取消归档 | **已接** | 刷新侧栏列表 | — |
| `thread/deleted` | 已删除 | **已接** | 前端从侧栏移除；当前会话被删则切走 | — |
| `thread/closed` | 已关闭（卸载） | 透传 | — | 释放本地订阅 |
| `thread/name/updated` | 改名 | **已接** | 前端刷新侧栏/标题；本窗 `renameSession` 仍等 RPC | — |
| `thread/goal/updated` | 目标已更新 | **专用** | 刷新目标条 | — |
| `thread/goal/cleared` | 目标已清除 | **专用** | 清空目标条 | — |
| `thread/settings/updated` | Thread 设置 | 透传 | — | 本会话模型/权限变化 |
| `thread/tokenUsage/updated` | token | **已接** | 输入栏「上下文用量」弹层（累计 / 窗口 / 拆分） | Cursor 式 System prompt / Skills 分类服务端没有 |
| `thread/compacted` | 压缩完成（**弃用**，改 ContextCompaction item） | 透传 | — | 提示上下文已压缩 |
| `thread/environment/connected` | 环境已连接 | 透传 | — | 远程环境指示 |
| `thread/environment/disconnected` | 环境已断开 | 透传 | — | 同上 |

### 3.3 配置 / 账号 / MCP / 模型 / 其它

| method | 作用 | 对接 | 当前对接了什么 | 未接可用于 |
|--------|------|------|----------------|------------|
| `warning` `configWarning` `deprecationNotice` `guardianWarning` | 各类警告 | **已接** | `useWorkbench` → `setError` | Guardian「仍要执行」另接 approveGuardian |
| `skills/changed` | Skill 集合变化 | **透传 + 前端已消费** | 插件页监听后重拉 `skills/list` | — |
| `hook/started` | Hook 开始 | 透传 | — | 调试 hooks |
| `hook/completed` | Hook 结束 | 透传 | — | 同上 |
| `mcpServer/oauthLogin/completed` | MCP OAuth 结束 | 透传 | — | 关登录窗 |
| `mcpServer/startupStatus/updated` | MCP 启动 | 透传 | — | MCP 状态点 |
| `account/updated` `account/rateLimits/updated` `account/login/completed` | 账号 | 透传 | — | 官方账号 UI |
| `app/list/updated` | app 列表 | 透传 | — | 刷新连接器 |
| `remoteControl/status/changed` | 远程控制 | 透传 | — | 远程控制状态 |
| `model/rerouted` | 换了模型 | 透传 | — | 提示「已改用 x」 |
| `model/verification` | 模型校验 | 透传 | — | 模型不可用警告 |
| `model/safetyBuffering/updated` | 安全缓冲 | 透传 | — | 输出延迟/审查中 |
| `fs/changed` | `fs/watch` 回调 | **透传 + 前端已消费** | `FilesPanel` 监听后刷新树 | — |
| `fuzzyFileSearch/sessionUpdated` | 模糊搜索中间结果 | **已接** | Composer `@` 文件渐进列表 | FilesPanel 仍用请求响应 |
| `fuzzyFileSearch/sessionCompleted` | 模糊搜索结束 | **已接** | 同上 | 同上 |
| `command/exec/outputDelta` | 独立 `command/exec` 输出（base64） | **已接** | 集成终端拼接输出 | — |
| `process/outputDelta` `process/exited` | `process/spawn` 流（schema 仍有通知；ClientRequest 目录无 spawn） | 透传 | — | 若 CLI 仍发，可当终端；新功能优先 `command/exec` |
| `externalAgentConfig/import/progress` | 外部配置导入进度 | 透传 | — | 迁移向导 |
| `externalAgentConfig/import/completed` | 导入完成 | 透传 | — | 同上 |
| `thread/realtime/started` | 实时会话开始 | 透传 | — | 语音会话（非 MVP） |
| `thread/realtime/itemAdded` | 实时会话新增 item | 透传 | — | 同上 |
| `thread/realtime/transcript/delta` | 转写增量 | 透传 | — | 同上 |
| `thread/realtime/transcript/done` | 转写结束 | 透传 | — | 同上 |
| `thread/realtime/outputAudio/delta` | 音频输出增量 | 透传 | — | 同上 |
| `thread/realtime/sdp` | WebRTC SDP | 透传 | — | 同上 |
| `thread/realtime/error` | 实时会话错误 | 透传 | — | 同上 |
| `thread/realtime/closed` | 实时会话关闭 | 透传 | — | 同上 |
| `windows/worldWritableWarning` | Windows 全局可写目录警告 | 透传 | — | Windows 安全提示 |
| `windowsSandbox/setupCompleted` | 沙箱装完 | 透传 | — | Windows |

---

## 4. ServerRequest（服务端 → 客户端，必须回 `result`/`error`）

| method | 作用 | 对接 | 当前对接了什么 | 未接可用于 |
|--------|------|------|----------------|------------|
| `item/commandExecution/requestApproval` | 批准跑命令（turn/start 路径） | **已接** | UI 展示 `command`/`cwd`/`commandActions`；决策 `accept`/`acceptForSession`/`decline`/`cancel`；可选 `applyNetworkAmendment` | — |
| `item/fileChange/requestApproval` | 批准改文件 | **已接** | 审批卡展示 `changes`/diff；决策同上四档 | `grantRoot` 仍可后置 |
| `item/permissions/requestApproval` | 额外 FS/网络权限 | **已接** | UI 展示请求的 permission profile；accept 时按 schema 回 `{permissions, scope}`（turn/session）；decline/cancel 空 grant；cancel 另 interrupt | — |
| `item/tool/requestUserInput` | 工具向用户提问（选择题/密钥） | **已接** | `codex:toolUserInput` + ToolUserInputDialog | — |
| `item/tool/call` | 让**客户端**执行 dynamic tool | **子集** | 桌面工具总线：`dynamicTools` 注入 + `cron.*` / `preview.*` / `desktop.*`；写操作确认卡；会话级覆盖；见 [DynamicTools.md](./DynamicTools.md) | — |
| `mcpServer/elicitation/request` | MCP elicitation（form / openai/form / url） | **已接** | `codex:mcpElicitation` + McpElicitationDialog；回 `accept`/`decline`/`cancel` | form content 细填可后置 |
| `account/chatgptAuthTokens/refresh` | ChatGPT token 过期（401） | **JSON-RPC -32601** | 自建网关通常不需要 | 官方登录刷新 token；应回 tokens |
| `attestation/generate` | 生成 attestation（需 capability） | **JSON-RPC -32601** | 未声明 `requestAttestation` | 企业证明 |
| `applyPatchApproval` | **Legacy** 补丁审批（旧 SendUserTurn） | **JSON-RPC -32601** | 当前走 turn/start，理论上不应出现 | 兼容旧 CLI；应回 legacy 形状 |
| `execCommandApproval` | **Legacy** 命令审批 | **JSON-RPC -32601** | 同上 | 同上 |

补功能时必须按 method 用生成的 Response schema 回包（或继续 `-32601` 直到做出 UI）。不要对非审批方法回 `{decision}`。

---

## 5. 已接路径上的缺口（不是「完全没接」）

这些方法已调用，但产品仍可加深：

| 能力 | 缺口 |
|------|------|
| 用户输入 | 已有 text / localImage / skill / mention；无 `image` URL、`text_elements` |
| 审批决策 | 四档决策已接；`grantRoot` / execpolicy 细项可后置 |
| 工具展示 | 命令流 / diff / reasoning / plan 已接；完整侧栏 diff 浏览器可后置 |
| Review | 已接 uncommitted / baseBranch / commit / custom + detached |
| 模型 | 本地 providers + 会话选 model；`model/list` 仅用于能力探测 |
| Git 工作区 | 本机 status / diff / stage / commit；标题栏 popover |
| 编辑器 | `AppSettings.editorCommand` |

---

## 6. 与 Product.md 功能对照

| Product 能力 | 主要 RPC | 现状 |
|--------------|----------|------|
| 新对话 / 续聊 / 改名 | `thread/start` `resume` `name/set` `list` `read`；`turn/start` | 已接 |
| 流式回复、中断、基础审批 | 上表 Turn + 审批（含 permissions） | 已接（accept / acceptForSession / decline / cancel） |
| Fork / Archive / Delete / Search | `thread/fork` `archive` `delete`；`thread/list.searchTerm` | fork / archive / unarchive / delete / `searchTerm` **已接** |
| 附图 / 额外上下文 | `turn/start` image、fs、mention | **localImage / skill / mention 已接** |
| Diff / Changed files | `turn/diff/updated`、`item/fileChange/*`、`fs/*` | Diff UI **已接**；`fs/*` 已接（文件面板） |
| 文件树 | `fs/readDirectory` `watch` `readFile`；`fuzzyFileSearch` | **已接**（会话标题栏切换文件面板） |
| 集成终端 | `command/exec*` | **已接** |
| Git | 本机状态条 + diff/commit popover；可选 `thread/metadata/update` | **已接** |
| MCP / Skills | `skills/*` `mcpServer*` | Skills / 插件 / MCP 配置与列表 / OAuth / elicitation **已接** |
| 模型 / 网关 | 本地 `providers[]` + 会话 model；`model/list` 能力探测 | **已接** |
| 官方账号 / Realtime 语音 | `account/*` `thread/realtime/*` | 明确非目标或后置 |

---

## 7. 维护

- 方法全集：`ClientRequest.json` / `ClientNotification.json` / `ServerNotification.json` / `ServerRequest.json` 的 `method.enum`；Rust 侧以 `generated/methods.rs` 为准。
- 已接 Params：把 schema 加入 `scripts/generate-rpc-types.py` 的 `WIRED_*_SCHEMAS` 后重新生成。
- 参数：`schemas/v2/*Params.json`。
- 升级锁定版本：同时改 `apps/codex-work/src-tauri/CODEX_VERSION` 和 `package.json` 的 `@openai/codex`，用该版本重新 `generate-json-schema`，再跑 `python3 apps/codex-work/scripts/generate-rpc-types.py`，然后 `npm install`（二进制随打包进入应用）。
- 功能待办与建议顺序：[ROADMAP.md](./ROADMAP.md)。改接线状态后同步该文件勾选。

# Codex Work Roadmap

对照 `apps/codex-work` 当前实现与 [Product.md](./Product.md) / [RPC-INVENTORY.md](./RPC-INVENTORY.md)。协议怎么接见 [RPC-WIRE.md](./RPC-WIRE.md)。

更新文档时：改代码后同步本文件状态（`[x]` / `[ ]`），并改 RPC-INVENTORY 对应行。

每条待办：**效果** = 用户看见什么；**方案** = 接哪条协议、改哪一层。自己点按钮的路径已经等 RPC `result` 再改 UI，不必改成等通知。

**对照代码（2026-09）**：P0 / P1 / 桌面波次 / P2 / **P3** 均已接线。接新方法仍走 `rpc_client.rs` → `commands.rs` → `src/api.ts` → UI；通知走 `runtime.rs` `handle_notification` → `useWorkbench.ts`。

---

## 已完成（不要再排进 P0）

- 新对话 / 续聊 / 改名 / 流式回复 / 中断
- 命令与写文件审批（仅 `accept` / `decline`）
- 会话归档、取消归档、删除（设置页已归档列表）
- 文件面板：树、预览、监视、模糊搜索
- Skills 列表/开关；插件安装/卸载
- 自定义网关 settings（baseUrl / apiKey / model）
- Pending Queue：chat 车道 + cron 车道（同一 drain，chat 优先）
- 已安排（CronJob v1 / v1.1）
- Dynamic Tools 总线：`cron.*`、`preview.open/close`

---

## P0 — 对齐 Codex App / Product MVP

### 会话

- [x] **分叉会话**
  - 效果：侧栏「从这里分叉」开出一条新对话，原会话不动；也可从某轮之后另开。
  - 方案：`thread/fork`（可选 `lastTurnId`）。用返回的新 `thread.id` 建侧栏行并打开。见 RPC-WIRE 末尾。

- [x] **搜索会话**
  - 效果：侧栏搜索按服务端历史匹配，不只能滤当前已加载的标题。
  - 方案：`thread/list` 传 `searchTerm`；结果 upsert 进侧栏。

- [x] （可选）**归档/删除通知**
  - 效果：别的窗口或外部客户端改了 Thread，本窗口侧栏马上对上。本窗口点归档仍等 RPC 返回再 `filter`，不改成等事件。
  - 方案：`handle_notification` 认 `thread/archived` / `unarchived` / `deleted`，前端从列表移除或刷新；当前会话被删则切走。

### 对话体验

- [x] **运行中插话**
  - 效果：Agent 还在跑时可以再发一句，立刻并进这一轮，不用先中断或排队。
  - 方案：`turn/steer`。不要用 Pending Queue：队列是当前轮**结束之后**的下一轮 `turn/start`。

- [x] **附图**
  - 效果：Composer `+` 选图，或把图片**直接拖进输入区**；发出后和纯文本同一轮进模型。拖进非图片文件不附图。
  - 方案：`turn/start` 的 `image` / `localImage`。入口两个：文件选择、Composer（及聊天区）`drop`。校验类型/大小后放进 input；拖拽与 `+` 共用同一份附件列表。

- [x] **Reasoning / Plan**
  - 效果：能折叠看思考摘要和计划，不再只有最终文本和工具卡。
  - 方案：`item/started` 不要丢 `reasoning` / `plan`；接 `item/reasoning/*`、`turn/plan/updated`。

- [x] **命令实时输出**
  - 效果：跑命令时 stdout/stderr 像终端一样往外刷，不用等命令结束。
  - 方案：专用处理 `item/commandExecution/outputDelta`，按 `itemId` 拼到工具卡。

- [x] **Diff / Changed files**（Product 成功标准第 6 条）
  - 效果：本轮改了哪些文件、补丁长什么样，会话里和审批卡里都能看。
  - 方案：会话级听 `turn/diff/updated`；工具卡听 `item/fileChange/patchUpdated`；写文件审批把 `changes` 画进卡。

### 审批补全

- [x] **额外权限审批**
  - 效果：Agent 要读写沙箱外路径或开网络时弹出「允许这些路径 / 开网络」，而不是静默 `-32601`。
  - 方案：`item/permissions/requestApproval` 走 `codex:approval`，按 Response schema 回包。

- [x] **本会话记住（`acceptForSession`）**
  - 效果：同类命令/写文件本会话不再反复弹。
  - 方案：审批 UI 增加选项；`decision` 发 `acceptForSession`。

- [x] **拒绝并取消整轮（`cancel`）**
  - 效果：点拒绝可以停掉这一整轮，而不只否决这一条命令。
  - 方案：审批回 `cancel`（或等价字段，以 schema 为准），并清运行态。

- [x] **命令审批看清要跑什么**
  - 效果：审批卡展示解析后的动作；需要时能改网络策略再同意。
  - 方案：把 `commandActions` 和 execpolicy/network 修正字段接到现有审批 UI。

---

## P1 — 次要产品目标

### 配置与模型

- [x] **多模型配置 + 会话选模型**
  - 效果：当前 **Provider** 下可添加多条模型（显示名 + 模型 ID）。Composer「自定义」改成下拉；**每个会话记住用哪条模型**。主场景是自建网关，不是官方 `model/list`。
  - 现状：全局一份 `model`；Composer chip 禁用。
  - 方案：当前 provider 下 `models: [{ id, label, model }]`。`thread/start` / `turn/start` / resume 传该会话的 `model`。换模型 **不** 重启 App Server。`model/list` / 网关 `GET /models` 仅作添加表单的可选建议。

- [x] **多 Provider（多套 baseUrl / apiKey）**
  - 效果：设置里可保存多套网关，同一时间只有一套 **当前 Provider**。Composer 模型下拉**底部一项**（如「更改网关…」）跳到设置去换 Provider，不在下拉里直接切网关。
  - 方案：settings 增加 `providers: [{ id, label, baseUrl, apiKey, models[] }]` + `activeProviderId`。保存或切换当前 Provider 后 **杀掉并重新 `RpcClient::connect`**（现有就是启动时 `-c` 注入一套 `model_providers` + `CODEX_WORK_API_KEY`）。重启前若有 running / 排队：提示，确认后 interrupt、队列策略与 PendingQueue 一致（建议先停当前轮）。Composer 只列出 **当前 Provider 的 models** + 跳转项。
  - 不做：Composer 里无确认直接切网关；启动时注入全部 provider 再靠 `modelProvider` 热切换（本条用「一份当前配置 + 重启」即可）。

- [x] **按 provider 能力藏 UI**
  - 效果：网关不支持图或 effort 时，Composer 不露出对应控件。
  - 方案：启动或切 provider 后调 `modelProvider/capabilities/read`。

- [x] **设置同步更多 config**
  - 效果：模型和 MCP 等能跟 App Server 合并后的 config 对上，不只 sandbox / approval 两键。
  - 方案：扩展 `config/read` / `config/value/write`（或 `batchWrite`）覆盖的 keyPath。

- [x] **实验开关**
  - 效果：设置里能开官方实验功能，不必改配置文件。
  - 方案：`experimentalFeature/list` + `enablement/set`。

- [x] **运行前缺项引导**
  - 效果：缺模型或 MCP 时设置页直接说明缺什么，而不是发消息才失败。
  - 方案：`configRequirements/read`，映射到现有校验 UI。

### MCP

没有设置页里的 **配置 + 列表**，后面几条都无处挂。对话里偶发的 `mcpToolCall` 卡不算管理面。

- [x] **MCP 配置与列表（先做）**
  - 效果：设置（或插件旁）能看到已配置的 MCP 服务器：名称、是否启用、是否起来、报错；点开能看到该服务器的 **tools**。能新增 / 编辑 / 删除 / 开关（命令、args、env 等）。改完立刻出现在列表里，Agent 下一轮能调到。
  - 方案：配置落在 App Server 的 config（`config/read` / `config/value/write` 的 mcp 相关 key，不要另做一份桌面 Store）。列表与工具用 `mcpServerStatus/list`（响应里已有 `tools` / `authStatus`）。保存后调 `config/mcpServer/reload`。通知 `mcpServer/startupStatus/updated` 刷新状态点。不要用 Dynamic Tools 再包一层 MCP。
  - 现状：无 MCP 页；插件页是 Skills/插件；`mcpServer*` 未接。

- [x] **MCP OAuth**
  - 效果：列表里 `authStatus` 为需登录时，能走完授权再变绿。
  - 方案：挂在上一条的列表行上；`mcpServer/oauth/login` + `mcpServer/oauthLogin/completed`。

- [x] **MCP elicitation**
  - 效果：MCP 要填表或打开 URL 时有对话框，服务端不会一直挂起。
  - 方案：`mcpServer/elicitation/request`（现 `-32601`）。无列表也能做，但应和配置页同一套 MCP 体验。

后置：`mcpServer/resource/read`、用户手动 `mcpServer/tool/call`（Agent 调用已有工具卡即可）。

### Composer 与 Code

- [x] **Composer `@` Skill**
  - 效果：输入 `@` 选出 Skill，这一轮带上 skill 输入。
  - 方案：复用已接 `skills/list`；`turn/start` 带 `skill`。

- [x] **Composer `@` 文件**
  - 效果：输入 `@` 搜仓库文件并挂进上下文。
  - 方案：复用已接 `fuzzyFileSearch`；`turn/start` 带 `mention`。

- [x] **Git 状态条**
  - 效果：标题栏看见分支、是否 dirty，不必自己跑 git。
  - 方案：`thread/metadata/update` 或读本地 git，做成专用 UI（不是再包一套 IDE）。

- [x] **文件面板复制/另存**
  - 效果：树上能复制文件，不必只删和预览。
  - 方案：`fs/copy` 已在 RpcClient，补 FilesPanel 按钮。

- [x] **用资源管理器 / IDE 打开当前项目**
  - 效果：当前会话所属项目能「在资源管理器中打开」和「用 VS Code（或其它 IDE）打开整个文件夹」。文件面板、会话标题栏也能做，不只能点侧栏项目菜单。
  - 现状：侧栏 `openPath(workDir)` + `codexApi.openInEditor(workDir)`。编辑器命令仍硬编码 `code` / `code.cmd`（见 `open_in_editor_cmd`），设置里没有首选编辑器字段。
  - 方案：本机 opener，不走 App Server。资源管理器继续 `openPath` / `revealItemInDir`。IDE：`open_in_editor_cmd`。首选命令未做，见 P3。

- [x] **用编辑器打开单个文件**
  - 效果：文件树选中或右键一个文件，可选「在 VS Code 中打开」（以及系统默认应用打开）。
  - 现状：`FilesPanel` 已有「在 VS Code 中打开」`openInEditor` 与「在资源管理器中显示」`revealItemInDir`。
  - 方案：与上条共用 `open_in_editor_cmd`。默认应用用 `openPath(file)`。不要做成内置 IDE。

---

## 桌面功能后续波次

### 已安排 — [ScheduledTask.md](./ScheduledTask.md)

- [x] **v2：从插件模板添加**
  - 效果：插件页一条 scheduled 模板一键进「已安排」，不用手抄 cron。
  - 方案：`plugin/read` → `plugin_schedule_to_cron` 写入 CronStore。

- [x] **后置：一次性闹钟 + 开机启动**
  - 效果：可设「某时刻跑一次」；系统开机后调度器跟着起来（仍要求应用在跑才开火的策略以 ScheduledTask 为准）。
  - 方案：Job 增加 `onceAt`；平台 Login Item / 等价开机项。

不做：cron 自建队列；busy 时直接 `turn/start`；为 cron 发明 App Server RPC。

### Dynamic Tools — [DynamicTools.md](./DynamicTools.md)

- [x] **更多 namespace**
  - 效果：设置里再开一组桌面工具（例如打开路径），聊天里模型能调。
  - 方案：登记表加 namespace；`handle_server_request` 的 `item/tool/call` 分支不用改。

- [x] **工具向用户提问**
  - 效果：工具要选择题或 secret 时弹输入，而不是 `-32601`。
  - 方案：`item/tool/requestUserInput`。

- [x] **fork 时带上工具 spec**
  - 效果：分叉出的新会话仍能调当前开启的桌面工具。
  - 方案：`thread/fork` / 随后 resume 注入与 start 相同的 `dynamicTools`。

- [x] **按会话覆盖开关**
  - 效果：某一会话关掉 cron 工具，其它会话不受影响。
  - 方案：会话级覆盖存本地，start/resume 只注入合并后的 spec。

不做：设置页自定义 schema；每个工具一条 JSON-RPC；MCP 再包一层本机 Store。

### 排队 — [PendingQueue.md](./PendingQueue.md)

- [x] **中断并清空两车道**
  - 效果：一键停当前轮，排队的 chat 和 cron 也全部丢掉。
  - 方案：`interrupt` + 清空 `chat_queue` / `cron_queue`，emit 快照。

- [x] **退出前提示未发送**
  - 效果：关掉应用时如果队列里还有话，弹出确认。
  - 现状：`useWorkbench` `onCloseRequested` 仍写「关闭将会丢失」；chat 车道已落盘（见下条），文案与行为不一致。对齐见 P3。
  - 方案：窗口 close 钩子读 `queueCount`；有排队则 `ask`，取消则 `preventDefault`。

- [x] **排队草稿持久化**
  - 效果：重启后未发出的排队消息还在。
  - 方案：`runtime.rs` `persist_chat_queue` → `chat-pending.json`；启动 `hydrate_queues`。cron 仍以 jobs.json 为准，不要双写。内存 `cron_queue` 仍随进程清空。

---

## P2

- [x] **集成终端**
  - 效果：不依赖当前 Turn，也能在沙箱里开一个可交互终端。
  - 方案：`command/exec*` + `command/exec/outputDelta`（PTY write/resize/terminate）。

- [x] **压缩上下文**
  - 效果：长会话点「压缩」，后续轮次变短、少爆上下文。
  - 方案：`thread/compact/start`，完成后提示；忽略已弃用的 `thread/compacted` 通知形态若 schema 已换 item。

- [x] **独立 Review**
  - 效果：「Review 这段 diff / 这些文件」走审阅流，而不是再灌进普通聊天。
  - 现状：`review/start` 仅 `target: uncommittedChanges` + `delivery: inline`（`ChatArea` / 侧栏「Review」）。
  - 方案：其它 target 见 P3。

- [x] **会话目标条**
  - 效果：会话顶上看见 objective / 状态 / token 预算（仍不是独立 Task 对象）。
  - 方案：`thread/goal/set|get|clear` 与 `thread/goal/updated`。

---

## P3 — Product 仍缺 / 已接路径加深

对照 [Product.md](./Product.md) §7 与代码。不新做 Agent 编排；能复用现成 Tauri command / RPC 的不要另开通道。接线步骤仍见 [RPC-WIRE.md](./RPC-WIRE.md)。

### Git（Product：Git status / diff / branch / Commit）

状态条已有：`get_git_status_cmd` 跑本机 `git status --porcelain=v1 --branch`，`ChatArea` 标题栏显示分支 / dirty / ahead / behind。工作区 diff / 提交挂在状态条 popover。

- [x] **工作区 Git diff**
  - 效果：标题栏点分支/dirty，能看见未提交文件列表和每个文件的 unified diff；和会话里「本轮变更」（`turn/diff/updated`，Agent 这一轮改的）分开。
  - 方案：本机 git。`get_git_diff_cmd` + `GitStatusPopover`。

- [x] **提交更改**
  - 效果：看完工作区 diff 后能填 message、暂存所选文件、`git commit`；失败原因可见。
  - 方案：`git_stage_cmd` / `git_commit_cmd`；UI 在 Git popover。

不做：内置 merge 冲突编辑器；push/pull 远程工作流（Product 也没要求）。

### 项目

侧栏已有打开 / 创建（`CreateProjectDialog`）/ 改名 / 删除 / 最近。`listed` 只用于无项目开聊时的隐藏 cwd，不要做成开关。

- [x] **项目改名**（不做改目录、不单开设置页）
  - 效果：项目「⋯」能改显示名。换工作目录：删掉旧项目（会话回「最近」），在新目录上再建一个。已打开 Thread 的 `cwd` 不跟着改。
  - 方案：侧栏已有 `rename`。**不要**改现有项目的 `workDir`（新旧会话 cwd 会分叉）。不要在项目里存 apiKey。

### 编辑器

- [x] **首选编辑器命令**
  - 效果：设置里填 `code` / `code.cmd` / 绝对路径 / 其它编辑器；文件面板和侧栏「用 IDE 打开」都走这一条。找不到命令时提示去设置改，而不是只报 PATH 失败。
  - 方案：`AppSettings.editorCommand`；`open_in_editor_cmd` / `desktop.openInEditor` 读 settings。

### Review / 会话标题

- [x] **Review 其它 target**
  - 效果：除「未提交更改」外，能对「相对某基线分支」或「某个 commit」发起 Review；可选在新会话里跑（detached）。
  - 方案：Git popover Review 区；`reviewStart` 支持 `baseBranch` / `commit` / `custom` + detached。

- [x] **模型自动改名刷新标题**
  - 效果：服务端给 Thread 起名后，侧栏和标题栏马上变，不必自己再改一次。
  - 方案：`thread/name/updated` → 更新本地 session 行。本窗口 `renameSession` 仍等 RPC 返回。

### MCP 后置（列表页已有）

挂在现有 `McpSettingsPane`，不要另做 Store。

- [x] **读 MCP resource**
  - 效果：某服务器详情里能列出/打开 resource，需要时把内容挂进下一轮上下文。
  - 方案：`mcpServer/resource/read`；设置页只读预览。

- [x] **用户手动调 MCP 工具**
  - 效果：列表里点某个 tool，填参数执行，结果出现在当前会话（或仅设置页预览）。
  - 方案：`mcpServer/tool/call`；设置页调试入口。

### Composer / 通知加深

- [x] **`@` 文件渐进结果**
  - 效果：输入 `@` 搜文件时边打边出结果，不必等整次 `fuzzyFileSearch` 返回。
  - 方案：`fuzzyFileSearch/sessionUpdated` / `sessionCompleted` + cancellationToken。

- [x] **关窗文案对齐落盘**
  - 效果：退出提示不说「会丢失」已经写进 `chat-pending.json` 的 chat 项。
  - 方案：chat 恢复提示；cron 内存调度另述。

- [x] **警告 toast**
  - 效果：`warning` / `configWarning` / `deprecationNotice` / `guardianWarning` 能看见，而不是只打日志。
  - 方案：`useWorkbench` 认四个 method → `setError`。

- [x] **其它窗口关掉审批卡**
  - 效果：这条 ServerRequest 已在别处解决时，本窗口审批/填表对话框关掉。
  - 方案：`serverRequest/resolved` 清本地 pending。

### 配置加深（可后置）

- [x] **权限档案对齐官方 profile**
  - 效果：设置里能选 App Server 的 permission profile，不只本地三档 sandbox/approval 预设。
  - 方案：`permissionProfile/list` + 写 `default_permissions`。

- [x] **`config/batchWrite`**
  - 效果：设置页一次保存多个 key，少几次往返。
  - 方案：权限写入走 `config/batchWrite`（sandbox + approval 一次）。

---

## 明确不做 / 可跳过

- 自研 Agent / 自研编排层 / 替代 App Server
- 强制账号、云同步、团队协作、模型市场、做成通用 IDE
- 官方 `account/*`、Realtime 语音、Windows 沙箱（除非产品改目标）
- legacy `applyPatchApproval` / `execCommandApproval`
- 已废弃 `thread/rollback`（回退用 fork + `lastTurnId`）
- 为 Linux/macOS/Windows **单独排产品待办**：各平台在本机装好依赖后跑现有 `npm run build`（见 [DEVELOP.md](./DEVELOP.md)）。`codex-runtime` 跟当前 OS；webkit 等是环境前置，不是功能缺口。


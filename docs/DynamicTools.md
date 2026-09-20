# Dynamic Tools（桌面自定义工具）

把**本机客户端能力**交给对话里的 Agent 调用。协议用 Codex **experimental Dynamic Tools**：在 `thread/start` 注入 spec，调用走 ServerRequest `item/tool/call`，客户端执行后回 `{ contentItems, success }`。

这是通用总线，不是某一个产品功能。已接入的消费者：`cron`（见 [ScheduledTask.md](./ScheduledTask.md)）与 `preview`（侧栏预览）。接线步骤见 [RPC-WIRE.md](./RPC-WIRE.md) §5。排队见 [PendingQueue.md](./PendingQueue.md)。

**结论：** App Server 不实现桌面业务。代码里登记工具目录；**设置页决定注入哪些**。`thread/start` 只带已开启的 spec。按 `namespace`/`tool` 分发到本机模块。读可立刻回；有副作用的调用先确认再执行。回包永远是 DynamicTool 的 result，**禁止**用命令审批的 `{ decision }`。

---

## 1. 要解决什么

Agent 跑在 Codex App Server 里，看不见 Tauri、本机 Store、侧栏页。用户却希望在聊天里完成「只有桌面有」的事：建定时任务、以后打开本地路径、改客户端设置等。

| 路径 | 何时用 |
|------|--------|
| **Dynamic Tools（本方案）** | 能力属于桌面客户端，要进模型 tool 列表 |
| MCP | 独立进程/外部系统；不要用 MCP 再包一层本机已有 API |
| Skill 文本 | 只教模型怎么说、怎么用已有工具；不执行本机 CRUD |
| Composer 拦截 / 斜杠 | 不经过模型选 tool；可后置，与本总线独立 |
| Agent 直接改客户端数据文件 | **禁止**（无校验、无锁、无 wakeup） |

不发明新的 App Server RPC（例如不要 `scheduledTask/*`）。不替代 exec / patch / MCP：那些仍走现有 item 类型。

---

## 2. 协议（已有，实验）

官方 App Server README：**experimental**。要求 `initialize.capabilities.experimentalApi = true`（本仓库已发）。未开则实验字段会被拒。

### 2.1 注册

`thread/start` 的 `dynamicTools`：`function` 或 `namespace`（`DynamicToolSpec`）。校验在 start 时做。注入列表 = **代码目录 ∩ 设置里开启的项**（§4），不是把设置页里的 JSON 当 spec 发给模型。

本仓库抽出的 `v2/ThreadStartParams.json` 原先顶层没有 `dynamicTools`（definitions 里有 `DynamicToolSpec`）。已把该实验字段补回 start/resume 的 properties，并加入 `WIRED_*_SCHEMAS` 生成 `ThreadStartParams.dynamic_tools`、`DynamicToolCallParams`、`DynamicToolCallResponse`。升级 Codex 后若 `generate-json-schema` 再次丢掉该 property，按 `generate-rpc-types.py` 顶部注释补回去再生成。

`thread/resume`：README 允许带与 start 相同的部分覆盖，**未写死**必须带 `dynamicTools`。接入时实测：

- resume 接受 → 每次 resume 注入**当时**设置算出的 spec，旧会话也能跟上开关变化
- 不接受 → 只保证上线后 **新开** 的会话；改设置对已有会话不生效，需新开一局

`turn/start` **不**注册工具。`thread/fork` 默认不注入，除非该产品明确要。

### 2.2 调用

```text
item/started   item.type=dynamicToolCall  status=inProgress
    → ServerRequest item/tool/call
         { threadId, turnId, callId, tool, arguments, namespace? }
    → 客户端 result { contentItems, success }
    → item/completed  带 contentItems / success / status
```

Schema：`schemas/DynamicToolCallParams.json`、`DynamicToolCallResponse.json`。

成功：

```json
{
  "contentItems": [{ "type": "inputText", "text": "…" }],
  "success": true
}
```

失败：同一形状，`success: false`，`inputText` 写中文原因。这是 **JSON-RPC result**，不是 `error`。

| 情况 | 怎么回 |
|------|--------|
| 已实现的 method，工具名未知 / 已关闭 / 参数非法 / 业务失败 / 用户拒绝 | `result` + `success: false` |
| 解析不了这次 ServerRequest、客户端崩了 | 才 `-32601` 或传输层失败 |

必须用**同一个 request `id`** 回答，否则 Turn 挂起。拒绝、关窗、用户 interrupt：仍回 `success: false`，不要丢包。桌面**不做**确认倒计时；Turn 跑多久由 App Server（如 `timeoutMins`）管。

`contentItems` 还可 `inputImage`（`imageUrl`）。v1 只用 `inputText`（JSON 或短句，给模型接着说）。

`item/tool/requestUserInput` 本波不接。要用户拍板：卡住这次 `item/tool/call`，用桌面确认 UI。

### 2.3 通知与 UI

`item/started` / `completed` 的 `dynamicToolCall` 已进前端 `item/toolCall`（`runtime.rs`）。卡片展示 `namespace`、`tool`、`arguments`、结果摘要。不要为每个业务再发明一种 item type。

---

## 3. 架构

```text
设置页「桌面工具」  →  DynamicToolsConfig（本机 JSON）
代码登记表 catalog()  →  specs() = 目录 ∩ 已开启
        ↓
thread/start|resume  + dynamicTools
        ↓
Agent 选某个 tool
        ↓
item/tool/call  →  runtime.handle_server_request
        ↓
  已关闭 → success: false（即使旧会话还带着旧 spec）
  registry.dispatch(namespace, tool, args, ctx)
        ↓
  只读 / 无确认 → 立刻执行业务模块
  需确认     → emit 前端卡 → 用户允许后再执行
        ↓
respond_typed DynamicToolCallResponse
        ↓
模型继续该 Turn
```

| 层 | 做什么 | 不做什么 |
|----|--------|----------|
| 设置页 | 开/关总线、namespace、单工具 | 不编辑 description / inputSchema / handler |
| `dynamic-tools.json` | 只存开关 | 不存 spec 副本 |
| `RpcClient::thread_start` / `thread_resume` | 带上 `specs()` | 不在 RpcClient 里写业务、不读设置文件细节 |
| `host/dynamic_tools.rs` | 目录、配置、过滤后的 spec、分发、确认策略、拼 `contentItems` | 不拥有各域数据；不 `turn/start` |
| 各业务模块（`host/cron.rs`、以后其它） | 唯一的校验 / 写盘 / 副作用 | 不感知 JSON-RPC；不读工具开关 |
| `runtime.rs` | `ItemToolCall` 分支；pending 确认；按 **调用上下文** 过滤（见 §6） | 不用 `{decision}` 回这个 method |
| 前端对话 | 通用确认卡 + 工具卡 | 不绕过 registry 自己 invoke 业务冒充 Agent |

RPC-WIRE 领域表加一行：桌面工具 → `host/dynamic_tools.rs`。各域文件不变。

### 3.1 登记表（代码，不是配置）

每个工具一条记录，而不是每个产品一份 RPC 处理函数。**能出现在设置页里的，只有这里登记过的项。**

```text
DynamicTool {
  namespace: "cron" | …        // 可选；无则扁平名
  name: "list"
  description: string          // 给模型；设置页只读展示
  inputSchema: JSON Schema
  sideEffect: none | mutate    // none 默认可自动执行
  confirm: bool                // mutate 默认 true；设置页不能改成「mutate 不确认」
  allowedIn: userChat | …      // 见 §6
  handler(ctx, args) -> Result<String, String>
}
```

`catalog()` 返回全部登记项。`specs()` 只编 **配置允许注入** 的项（优先 Namespace 分组；CLI 不稳则扁平 `cron_list`，分发留别名）。

加新能力 = 代码登记一条 + 实现 handler。新项若配置文件没写过，默认跟随 **该 namespace 的开关**（namespace 也没写过则跟随总开关，见 §4.2）。不要复制 `handle_server_request` 分支。

`ctx` 至少：`threadId`、`turnId`、`callId`、是否 scheduled 轮、当前会话的 `projectId`。handler 用 ctx 填默认值，**不要**让模型传任意本机绝对路径当权威 cwd（除非产品明确要且确认卡展示路径）。

---

## 4. 配置与设置页

配置回答的是：**下次对话把哪些工具交给模型**。不回答「这个工具怎么实现」。

### 4.1 两层：目录 vs 开关

| | 谁写 | 内容 |
|--|------|------|
| **目录** | 代码 `catalog()` | name、description、schema、handler、是否确认 |
| **配置** | 用户，设置页 | 总开关、namespace 开、单工具开 |

禁止在设置里：粘贴自定义 `inputSchema`、加未登记的 tool 名、改 description 骗模型、把 mutate 设成免确认。那等于对模型开放任意本机 API。

Agent **不得**用 Dynamic Tool 改这份配置（避免自己给自己提权）。改开关只走人设置页。

### 4.2 数据

路径：`store::get_data_root()/dynamic-tools.json`（与 `settings.json` 分开，避免和 apiKey 混在一起）。原子写。不进 Git、不进 App Server。

```ts
interface DynamicToolsConfigFile {
  version: 1;
  /** 总开关。false → specs() 为空，dispatch 全部当关闭 */
  enabled: boolean;
  namespaces: Record<string, {
    enabled: boolean;
    /** 省略的 tool = 跟随 namespace.enabled */
    tools?: Record<string, boolean>;
  }>;
}
```

缺文件 / 缺键时的默认：

- `enabled`: **true**（总线开；否则聊天建任务等能力默认不可用）
- 未出现的 namespace：跟随总开关（即默认开）
- 未出现的 tool：跟随其 namespace
- 文件里出现、代码里已删除的 id：忽略，下次保存时丢掉

生效规则（**注入和执行都要判**，旧会话可能仍带着已关工具的 spec）：

```text
注入? = 总开 ∧ namespace 开 ∧ tool 开
执行? = 同上；再 ∧ §6 上下文允许
任一关 → 不进 specs()；若仍被调用 → success: false「工具已在设置中关闭」
```

改配置立刻写盘。下一次 `thread/start` /（若支持）`thread/resume` 用新 `specs()`。当前正在跑的 Turn 不热替换模型 tool 列表。不必重启应用。

### 4.3 设置页 UI

落在现有 `SettingsPage`，侧栏分组 **个人** 下增加一项 **桌面工具**（不要塞进「常规」的模型表单，也不要和新的 Cron 业务页混在一起）。

页内：

1. **总开关**「允许 Agent 使用桌面工具」+ 短说明：应用没开等于这些能力不存在；关闭后新对话不再带工具。
2. **按 namespace 分组**（数据来自 `catalog()`，不是手写列表）。组头：显示名、一句话、组开关。
3. 组内每条 tool：显示名、只读 description、`只读` / `会改本机数据（调用时确认）`、单条开关。
4. 空态：代码还没登记任何工具时写「暂无可用桌面工具」。

显示名可以是中文（设置页专用）；发给模型的仍是登记表里的 `name` / `description`。

不提供「对本会话临时开启」v1；要裁剪就关设置或新开对话。

### 4.4 Tauri

| command | 作用 |
|---------|------|
| `list_dynamic_tools_cmd` | 目录 ∪ 当前开关，给设置页渲染 |
| `set_dynamic_tools_config_cmd` | 校验 id 属于目录后写盘 |

不要每个 tool 一个 command。对话路径只调 `cron::*` 等业务 API，不经过「设置」command。

---

## 5. 确认与安全

### 5.1 何时确认

| `sideEffect` | 默认 |
|--------------|------|
| `none`（只读、无本机变化） | 不确认，立刻执行 |
| `mutate`（写盘、删、改设置、入队执行、打开外部程序） | **确认**；拒绝则不执行 |

个别只读若会泄露敏感列表，可以把 `confirm` 打开。不要依赖模型「先问再调」代替确认。设置页不能关闭 mutate 确认。

### 5.2 确认卡（通用）

卡住该 ServerRequest。UI 可复用审批壳，**回包必须是** `DynamicToolCallResponse`。

卡上展示：namespace/tool、handler 预览的摘要（将写入的关键字段）、允许 / 拒绝。

- 允许 → 执行 handler → `success: true` + 结果文本
- 拒绝 / 用户 interrupt → `success: false`，「用户未确认」或「用户中断」；**无副作用**
- 不做确认倒计时：卡一直挂到用户点或 interrupt；执行超时交给 App Server
- 关应用：与其它未完成 ServerRequest 一样；handler 不得半写入

前端一个 `respondDynamicTool(requestId, allowed)`。不要每个工具一个 Tauri command。

### 5.3 通用禁止

- 在 handler 里对 App Server 再 `turn/start`（busy 会并进当前轮，见 PendingQueue）。要开一轮 Turn 的能力必须走 runtime 已有入队 API。
- 用 MCP / shell 改客户端 Store 文件。
- 未登记或已关闭的 tool 名回 `-32601`（method 已实现；应 `success: false`）。
- 静默执行 mutate（不确认、不因「注入了工具」就建数据）。
- 用 Dynamic Tool 改 `dynamic-tools.json`。

---

## 6. 按调用上下文过滤

同一套 spec 可能出现在不该用的 Turn 上（例如某 thread 聊天时注入过，后来被 Cron resume）。**执行时**按 ctx 再挡一层，不要只靠「那次 start 没带 spec」。

| 上下文 | 默认 |
|--------|------|
| 用户聊天 Turn | 允许**当前配置开启**的工具 |
| Cron / 其它无人值守 `execute_job`（`scheduled_job_id` 已有） | **拒绝 mutate**；v1 建议只读也拒绝，避免无人值守摸本机库 |
| 以后其它 origin | 在登记表 `allowedIn` 里显式打开 |

注册侧（减少模型误调）：

- 用户路径的 `thread/start` / `thread_resume`：注入 `specs()`（已过滤关闭项）。
- 无人值守新开的 thread：**不注入**。
- 无人值守 resume：不注入；仍可能残留旧 spec → 靠上表执行期拒绝。

---

## 7. 产品行为（通用）

- **用**工具不必先打开设置；确认发生在当前对话。
- **开/关**哪些工具必须去设置页「桌面工具」。
- 成功后权威数据在工具返回文本里；Agent 只做自然语言复述。
- 工具 `description` 写清能力边界（例如「应用没开就不会触发」），避免模型乱承诺。
- 侧栏 / 业务页仍是第一公民入口；聊天是同一业务模块的另一条入口，不是第二份实现。

---

## 8. 实现步骤

1. **Spike（先于业务工具）**  
   锁定 CLI：`thread/start.dynamicTools` 是否接受；resume/fork；namespace 在 `item/tool/call` 上如何出现。失败则停，改扁平 function 或升级 Codex，不编造 ClientRequest。

2. **生成类型**  
   `DynamicToolCallParams` / `DynamicToolCallResponse` 已进 `WIRED_*_SCHEMAS`。`ThreadStartParams` / `ThreadResumeParams` 已补 `dynamicTools`。`thread/start|resume` 走 `request_typed`；`item/tool/call` 回 `respond_typed`。

3. **`host/dynamic_tools.rs`**  
   目录、`dynamic-tools.json`、`specs()` / `dispatch()`、确认标记。设置读写 command。先可只挂一个示例工具（§9），框架要能加第二条而不改 runtime 分支。

4. **`rpc_client.rs` / `runtime.rs`**  
   用户 start/resume 带当时 `specs()`；`ItemToolCall` 统一进 registry（含已关闭判定）；pending 确认；ctx 注入。

5. **前端**  
   `SettingsPage` 增加「桌面工具」。对话里：通用确认卡 + 工具卡。`respondDynamicTool`。

6. **文档**  
   RPC-INVENTORY：`item/tool/call` → 子集。JSON-RPC.md §5.4。各业务文档只写「经 Dynamic Tools 暴露哪些 handler」，不复制协议。

---

## 9. 示例：Scheduled Task

以下不是总线本身，只说明**一个消费者怎么挂上去**。字段默认、三种跑法、漏触发以 [ScheduledTask.md](./ScheduledTask.md) 为准。

**为何适合做第一个消费者：** 闹钟只在本机；Agent 口头答应不会写 `jobs.json`；已有 `cron::*`，handler 只做映射。

Namespace：`cron`。设置页分组名「已安排」。CLI 对 namespace 不稳则扁平名 + 别名。默认总开 + 该组开（§4.2），用户可在设置里关掉整组或关掉 `delete` 等单条。

| tool | sideEffect | confirm | handler |
|------|------------|---------|---------|
| `list` | none | 否 | `list_jobs` 摘要 |
| `upsert` | mutate | 是 | → `upsert_job` |
| `set_enabled` | mutate | 是 | `set_enabled` |
| `delete` | mutate | 是 | `delete_job` |
| `run_now` | mutate（入 cron 车道） | 是 | `try_run(manual)`；busy 只 `enqueue_cron` |

`source.kind = "user"`。不要标 `plugin`。

`upsert` 对模型暴露能进现有校验的子集即可：`name`、`prompt`、节奏（`cronExpr` 或快捷项）。未传则桌面填默认：`origin=newInProject`、`repeat=reuseFirst`、`projectId=当前会话项目`、`approvalPolicy=never`、`timeoutMins=30`。默认**不** `bindExisting` 当前聊天。`onceAt` 拒绝。改已有任务传 `list` 回来的 `id`。

执行期：`scheduled_job_id` 已有则全部 `cron.*` 失败（「定时执行轮次不能改任务」）。`run_now` 禁止 `turn/start`。设置里关闭的 `cron.*` 同样失败。

确认卡摘要：名称、节奏、prompt 截断、项目、`nextRunAt`。Composer 仍不编辑周期任务；侧栏页保留。

Cron 专项测试（非法 cron、wakeup、bind 已删会话）写在 ScheduledTask / 实现 PR，不挤进总线通用测试。

---

## 9.1 示例：Preview

侧栏 Preview 是本机 UI，以前用独立 MCP 子进程 + 本机 HTTP 控制口把 `preview_open` / `preview_close` 交给模型。那是「MCP 再包一层本机已有 API」，与 §1 不符。现改为本总线的 `preview` namespace：handler 直接 `emit` 前端事件，会话绑 `ctx.threadId`。

| tool | sideEffect | confirm | handler |
|------|------------|---------|---------|
| `open` | none | 否 | 校验 http(s) URL → `preview-opened` |
| `close` | none | 否 | 关掉该会话侧栏与弹出窗 → `preview-closed` |

不让模型传 `sessionId`。用户路径 `thread/start|resume` 在 preview 开启时附带 developer instructions，说明本客户端没有 Browser / Chrome / Computer Use。无人值守 Turn 不注入、执行期仍拒绝。设置里可关掉整组。

---

## 10. 测试（总线）

- 未知 tool / 设置中关闭 → `success: false`，不是 `-32601`；关闭项不出现在下一次 `thread/start` 的 `dynamicTools`。
- 总开关关：`specs()` 为空。
- 只读：无确认 UI，Turn 能结束。
- mutate 拒绝 / interrupt：无副作用，`success: false`。
- mutate 允许：只走对应业务模块一次。
- 无人值守 Turn 调 mutate → 拒绝。
- 挂着 `item/tool/call` 时用户 interrupt：仍要回这次 request（false 或随 interrupt 的失败路径），不能让服务端一直等。
- 加第二个 namespace：设置页多一组，不改 `handle_server_request` 的 method 分支。
- 配置文件含已删除的 id：加载忽略，保存后不再写出。

示例消费者手动：设置里 `cron` 开启 → 新对话「每个工作日 9:00 用这段 prompt 建任务」→ 确认 → 已安排出现。关掉 `cron` 后再新开对话，模型不应再调到这些工具。

---

## 11. 分波

| 波次 | 内容 |
|------|------|
| **spike** | 本 pinned Codex 上 `dynamicTools` / resume / namespace |
| **v1 总线（已做）** | 登记表 + 配置文件 + 设置页开关 + `item/tool/call` 回包 + 通用确认卡 + 工具卡 |
| **v1 示例（已做）** | `cron`：`list` / `upsert` / `set_enabled` / `delete` / `run_now`；scheduled 拒写 |
| **v1.1（已做）** | `preview`：`open` / `close`（替代 MCP）；resume 时按当前设置注入 spec |
| **后置** | 更多 namespace；`item/tool/requestUserInput`；fork 注入；按会话覆盖开关 |
| **不做** | 设置页自定义 schema/handler；每个工具一条 RPC；MCP 包本机 Store；busy 时 `turn/start`；无确认的 mutate；Agent 改工具开关；确认卡倒计时（执行超时归 App Server） |

---

## 12. 文档关系

- 本文件：桌面 Dynamic Tools **总线**（目录、设置页开关、调用、确认、上下文过滤）。
- [ScheduledTask.md](./ScheduledTask.md)：Cron 产品；聊天入口 = 本总线的 `cron` 示例（设置里可关）。
- Preview 侧栏：聊天入口 = 本总线的 `preview`（`open` / `close`），不再走 MCP。
- [PendingQueue.md](./PendingQueue.md)：要开 Turn 时的排队；冲突以它为准。
- [RPC-INVENTORY.md](./RPC-INVENTORY.md) / [JSON-RPC.md](./JSON-RPC.md)：`item/tool/call` 是否已接。
- [RPC-WIRE.md](./RPC-WIRE.md)：接 ServerRequest 的步骤。

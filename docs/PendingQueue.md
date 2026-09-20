# Pending Queue（Turn 排队）

Composer、定时任务、以及以后任何「想开一轮 Turn」的模块，都走 runtime 里**同一套排队**。当前 Turn 结束后再串行执行。

协议边界见 [RPC-INVENTORY.md](./RPC-INVENTORY.md)；Cron 产品见 [ScheduledTask.md](./ScheduledTask.md)。

---

## 0. 给对接方的结论（先读这个）

1. **排队是客户端 runtime 行为**，不是 App Server 新 RPC。不落盘、不进 `jobs.json`。
2. App Server 对同一 thread **busy 时再 `turn/start` 会并进当前轮**（等同 `turn/steer`）。因此：`running == true` 且同一会话时走 **`turn/steer`**（Composer 插话）；**不要**再 `turn/start`。只有无 active turn、跨会话 busy、或 steer 失败时才入 chat 队列。
3. 同时只跑我们跟踪的一个 `active_turn`。不要并行多 Turn。`turn/steer` 是当前轮插话，不是队列。
4. 排空是**两车道**：先 `chat`，空了再 `cron`。同车道 FIFO。正在跑的那条不在队列里。
5. Drain **一次只启动一条** Turn；该 Turn 结束再 drain 下一条。禁止在 completed 回调里递归跑完整个队列。
6. 入队权威在 **Rust `runtime.rs`**。前端/其他模块不要自己猜 busy 再决定发不发。

---

## 1. 为什么必须在客户端排队

实测（Codex App Server）：同一 thread 上 Turn 进行中再 `turn/start` **不报错**，返回同一 `turn.id`，第二句并进当前轮。

所以「排队」不能靠服务端拒收。runtime 必须：

- 用本地 `running` 表示「我们跟踪的当前轮」
- busy → 入对应车道
- Turn 结束（`turn/completed` | `turn/error` | `turn/interrupted`，以及 `start_turn` 同步失败）→ `schedule_drain`

`pending_approvals`、新对话 `pendingProjectId` **不是**本队列。

---

## 2. 机制

```text
                    ┌─────────────┐
  chat 入队 ───────►│ chat_queue   │──┐
                    └─────────────┘  │
                    ┌─────────────┐  │   running==false
  cron 入队 ───────►│ cron_queue   │──┤        │
                    └─────────────┘  │        ▼
                                     │   drain 一次 pop 一条
                                     │        │
                                     ▼        ▼
                              chat 非空？──是──► start_turn(item)
                                     │
                                     否
                                     ▼
                              cron 非空？──是──► execute_job(item)
                                     │
                                     否 → 停
```

### 2.1 两车道

| 车道 | 谁入队 | Drain 优先级 | 去重 |
|------|--------|--------------|------|
| **chat** | Composer / 任何走 `start_turn` 且 busy 的调用 | 先 | 无；上限 20 |
| **cron** | Scheduler 到期 /「立即跑」且 busy | chat 空了才轮到 | 同一 `jobId` 最多 1 条 |

用户已点发送的下一句，不能被中间到期的 Cron 插到前面。同车道内不插队（「立即发送」是唯一例外：把**指定 chat 项**提到 chat 队首，仍不越过正在跑的那轮）。

### 2.2 状态机

Runtime 内存：

| 字段 | 含义 |
|------|------|
| `running` | 正在跑一轮 Turn。true 时禁止再 `turn/start` |
| `draining` | drain 互斥，防止 completed 回调重入 |
| `chat_queue` | `VecDeque<ChatPending>` |
| `cron_queue` | （v1.1）`VecDeque<CronPending>` + `HashSet<jobId>` |

关应用丢队列。删会话：`clear_session_pending(sessionId)` 只清该会话的 chat 项；cron 不动。

### 2.3 入队（chat）

`start_turn`：

```text
text 空 → err
running == true 且同 session 有 active_turn → turn/steer，return ok
running == true 但无 turn / 跨 session / steer 失败 → enqueue_chat，return { ok: true, queued: true, pendingId }
!running → running=true，run_turn（真正 turn/start）
chat_queue.len >= 20 → err「排队已满（最多 20 条）」
```

客户端可传 `pendingId`（乐观 id）。Rust 用它当队列 key，避免快照再插一条重复项。未传则 Rust 生成 UUID。

无 session 时仍先 `createSession`，第一句直接跑，不入队（没有 thread 可排队）。

### 2.4 Drain

挂在：`turn/completed` | `turn/error` | `turn/interrupted`、App Server `Error`、以及 `run_turn` / `start_turn` **同步失败**清 `running` 之后。

```text
schedule_drain → spawn:
  若 draining 已 true → return
  draining = true
  若 running → draining=false; return     // 当前轮还没真正结束
  pop chat 队首
    有 → emit 快照；抢 running；成功则 run_turn；失败则 running=false 再 schedule_drain
    无 → （v1.1）pop cron 队首 → execute_job
  draining = false
```

硬约束：drain 抢到 `running` 失败（竞态）→ 把该项 **push_front 放回**，等下一次结束再试。

### 2.5 删除 / 立即发送（仅 chat 项）

**`cancel_pending { id }`**

- 按 id 从 `chat_queue` 删；不在队里 → ok no-op
- 不 interrupt 当前轮
- emit 快照

**`send_pending_now { id }`**

```text
按 id 找到 chat pending；找不到 → err
从原位置摘掉，sendingSoon=true，插到 chat 队首（其余 sendingSoon 清掉）
emit 快照
若 running → turn/interrupt；等 interrupted|completed|error 再 drain
若 !running → 立刻 drain（会 pop 队首并 start_turn）
```

立即发送途中 **不得** 再对未结束的 turn 调第二次 `turn/start`。

正在跑的那句不在队列里；这两类操作只作用于排队项。

Composer「停止」只 `turn/interrupt` 当前轮，**不清队列**；结束后照常 drain。

### 2.6 焦点

Drain 到**另一条** session 的 chat，或 Cron 的 `newInProject`：**不要**强制切主界面。当前打开的会话继续显示；该会话的排队项从 `codex:queue` 快照恢复。正在看的会话若正是下一条 chat 的 `sessionId`，流式仍走 `codex:event`。

---

## 3. 数据

不进 `jobs.json`，不进 App Server。快照事件 `codex:queue`（整表替换，条数少）。

```ts
type QueueLane = "chat" | "cron";

interface ChatPending {
  id: string;              // 客户端 pendingId 或 Rust UUID
  lane: "chat";
  sessionId: string;       // threadId
  projectId: string;
  text: string;
  createdAt: string;      // ISO
  sendingSoon?: boolean;   // 已被 send_pending_now 提到队首，等 drain
}

interface CronPending {
  id: string;              // 等于 jobId，用于去重
  lane: "cron";
  jobId: string;
  createdAt: string;
}

interface QueueSnapshot {
  chat: ChatPending[];
  cron: CronPending[];     // 待跑的 cron 车道；空表示没有积压
}
```

`start_turn` busy 时返回：

```ts
{ ok: true, queued: true, pendingId: string }
```

失败（空消息、已满、缺 session 等）才 `ok: false`。

---

## 4. 对接契约（其他模块怎么接）

权威代码：`apps/codex-work/src-tauri/src/runtime.rs`。不要在 UI / cron 里再实现一套 FIFO。

### 4.1 现在就能用（v1）

| 能力 | 怎么调 |
|------|--------|
| 想发一轮聊天 Turn | `runtime.start_turn(app, StartTurnInput)`。busy 会自动入 chat 车道并 `emit("codex:queue")` |
| 当前轮结束 | 已有 notification 路径会 `schedule_drain`。**不要**自己再 `turn/start` |
| 删会话 | `delete_session` 已调 `clear_session_pending` |
| 取消某条 chat | Tauri `cancel_pending_cmd` |
| 某条 chat 插队 | `send_pending_now_cmd` |

前端：`api.onQueue` 听快照；`queued: true` 的消息只进排队面板，**不要**因此把 `running` 设 true。

### 4.2 Cron（v1.1 已接）

`cron.rs` 经 `runtime.enqueue_cron` / `cancel_cron_pending` 接入同一 drain。不要改 drain「一次一条」和「chat 优先」。快照 `cron` 在有待跑 job 时非空；已安排页可听 `codex:queue`。

权威 API（落在 `runtime.rs`，由 `cron.rs` 调，不要从 cron 直接 `turn/start`）：

```text
enqueue_cron(jobId) →
  已在 cron_queue → no-op（去重）
  否则 push_back，emit 快照
  然后 schedule_drain（idle 则立刻 pop；busy 则等）
  推进 nextRunAt 由 Cron 的 try_run 负责（见 ScheduledTask.md §5.4）

cancel_cron_pending(jobId) → 按 jobId 从 cron_queue 删；不 interrupt 当前轮；emit 快照
  （删/停用 CronJob 时由 cron.rs 调用）

execute_job 结束（成功 / 失败 / 超时 interrupt）→ 必须 schedule_drain
  （Cron 不一定走 start_turn 的 completed 路径）
```

规则：

- **禁止** cron 在 `running == true` 时自己 `turn/start`。
- **禁止** cron 插到 `chat_queue` 前面。
- 同一 `jobId` 在 cron 车道只留 1 条；到期两次且一直 busy → 仍 1 条。
- 审批弹窗阻塞**当前**轮，不阻塞入队。聊天项用全局审批；Cron 跟任务上的策略（如 `never`）。

### 4.3 若再加第三条「来源」

先问：它是用户跟帖（chat），还是后台闹钟（cron）？

- 用户主动发的（含「用某条工具结果再问一句」）→ **chat 车道**，走 `start_turn`。
- 到点/系统触发、可去重 → **cron 车道**（或以后显式的第三车道，但必须写清相对 chat/cron 的优先级，并改 drain 顺序文档）。

不要为每个功能新建一条绕过 `running` 的 `turn/start`。

---

## 5. 落点

| 层 | 做什么 |
|----|--------|
| `runtime.rs` | `running` / `draining` / `chat_queue` / `cron_queue`；`enqueue_chat` / `enqueue_cron`；`drain`；`cancel_pending` / `send_pending_now` / `clear_session_pending` / `cancel_cron_pending`；emit `codex:queue` |
| `commands.rs` | `cancel_pending_cmd { id }`；`send_pending_now_cmd { id }` |
| `types.rs` | `ChatPending` / `QueueSnapshot` / `StartTurnInput.pendingId` / `ResultOrError.queued` |
| `cron.rs` | busy/idle 一律 `enqueue_cron`；execute 结束 → `schedule_drain`；删 job → `cancel_cron_pending` |
| `useWorkbench` | `onQueue` 合并进当前会话消息（`queued`）；busy 仍 `start_turn`；乐观 `pendingId` |
| `ChatArea` | 输入不因 `running` 禁用；composer 上方排队面板 |

Tauri 事件：`codex:queue` → `QueueSnapshot`。

**不接** `turn/steer`。那是往**当前** Turn 塞 input；本队列是当前轮 **结束之后** 的下一轮 `turn/start`。

---

## 6. 聊天 UI（实现现状）

只服务 chat 车道，不是队列协议的一部分。

- textarea 不因 `running` 禁用；placeholder 提示将入队。
- 排队项**不进主消息流**；composer 上方一体式面板（`composer-stack`）。
- 可折叠：`N 条排队消息`；空心圆点条目。
- 每条右侧悬停两个 icon：**立即发送**（`send_pending_now`）/ **删除**（`cancel_pending`）。`sendingSoon` 时 disable。
- 面板底栏：`停止`（interrupt，⌘/Ctrl+Shift+Backspace）。空闲时「当前任务结束后按序发送」。
- composer 工具栏仍可中断当前轮 + 发送（入队）。

---

## 7. 分波

| 波次 | 内容 |
|------|------|
| **v1（已做）** | chat 车道：busy 入队、Turn 结束 drain、上限 20、删除 / 立即发送、排队面板 |
| **v1.1（已做）** | cron 车道接入同一 drain；`jobId` 去重；快照含 `cron` |
| **后置** | 中断并清空两车道；退出前提示未发送；按会话持久化排队草稿 |

---

## 8. 测试（对接时回归）

- 跑着再发两句 → 队列 2；结束后两轮独立 `turn/start`（两个 turn id）。
- 上限 21 句 → 第 21 失败，前 20 仍在。
- 中断当前轮 → 队列还在，随后 drain 第一条 chat。
- 删除中间一条 → 只跑其余。
- `[A,B,C]` 点 B 立即发送 → interrupt；结束后先 B，再 A、C。
- 空闲时对某条立即发送 → 立刻 `start_turn` 该条。
- 立即发送途中不得第二次 `turn/start` 打进未结束的 turn。
- 删会话 → 该 session 的 chat pending 消失。
- （v1.1）用户排队一句 + Cron 到期 → 先用户句，再 Cron。
- （v1.1）同一 Cron 到期两次且一直 busy → cron 车道仍 1 条。

---

## 9. 非目标

- 不是 `turn/steer`（中途插话）。
- 不是多 `active_turn` 并行。
- 不是把排队同步到 App Server。
- 不是审批队列（`pending_approvals` 仍阻塞当前轮）。

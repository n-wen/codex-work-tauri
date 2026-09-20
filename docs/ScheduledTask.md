# Scheduled Task / CronJob（已安排）

侧栏「已安排」的产品与实现方案。协议边界以 [RPC-INVENTORY.md](./RPC-INVENTORY.md) 为准；接线步骤见 [RPC-WIRE.md](./RPC-WIRE.md)；产品语言见 [Product.md](./Product.md)；Turn 排队见 [PendingQueue.md](./PendingQueue.md)。

**结论：** App Server 没有 `scheduledTask/`*。闹钟由本桌面客户端拥有。到期后把 prompt **伪装成一轮普通 Turn**。**禁止**在 `running == true` 时自己调 `turn/start`（服务端会并进当前轮）；busy 只走 runtime **cron 车道**。落点是 `host/cron.rs` + `runtime.enqueue_cron`。

---

## 1. 要解决什么

官方 Codex App 侧栏「已安排」：用户挂一条周期 prompt，到点自动开一轮 Agent。本仓库 v1 / v1.1 已落地（侧栏页 + Scheduler + cron 车道）。


|      | 对话任务         | 已安排（CronJob）                   |
| ---- | ------------ | ------------------------------ |
| 入口   | Composer     | 侧栏独立页                          |
| 协议   | `turn/start` | **无**专用 RPC；触发后仍走 `turn/start` |
| 生命周期 | 一轮 Turn      | 多条 run                         |


`thread/goal/*` 是会话目标，不是闹钟。`plugin/read.scheduledTasks` 是插件目录里的**模板**，不是用户任务库。

---

## 2. 方案要点

```text
CronStore（JSON + 锁 + 原子写）
  → Scheduler（nextRunAt）
    → try_run → runtime.enqueue_cron → drain → execute_job
      → Agent 无感知
```

- **一种 Job、一个调度循环。** 周期任务落盘的是 **5 字段 cron 表达式**；一次性以后加绝对时间 `onceAt`，仍走同一 `nextRunAt`。
- **调度**用 cron 表达式库（Rust，如 `cron` + `chrono`）从 `cronExpr` 算下一点。UI 快捷项（每天 / 工作日 / …）和插件 `ScheduledTaskSchedule` 都在**写入前转换成 cron**，不把 hourly 对象存进 jobs.json。
- **执行**只走 runtime：idle 则 `execute_job`（内部 `run_turn`），busy 则 `enqueue_cron`。**不要**在 cron 里再实现一套 FIFO，**不要** busy 时直接 `turn/start`。
- **会话：** 项目下新开，或绑已有 Thread。新开还有后续策略：每次都新开，或第一次 start 之后一直 resume 那条。
- **排队：** 与 Composer 共用 [PendingQueue.md](./PendingQueue.md) 两车道；先 chat 后 cron；同一 `jobId` 最多 1 条。
- **漏触发：** 周期过期最多补 1 次，再从 now 算下一点。once（后置）过期 ≤5min 立刻跑，更久标 missed。
- **超时**默认 30min，然后 `turn/interrupt`。
- **接入**只有 Tauri command + 已安排页。跑在哪个目录看 `projectId`；最近一次对话看 `lastThreadId`。

---

## 3. 约束

与 Product §3 / §8 / §9 一致：

- 不自研 Agent。调度器只决定何时把哪段 prompt 送进现有 Turn。
- 不发明 App Server 方法；不把任务同步到云。
- 不因安装插件而静默建任务。
- v1 应用未运行则错过；不做 launchd / 计划任务。
- 前端不 `setInterval` 开火。
- **不**在 `running` 时对 App Server 再发 `turn/start`（会并进当前轮，见 PendingQueue §1）。

---

## 4. 架构（一个模块）

```text
ScheduledTasksPage
  → api.ts / Tauri commands
  → host/cron.rs
        ├── CronStore          # jobs.json，Mutex，tmp+rename
        ├── schedule.rs        # cron 解析、next、插件 schedule → cronExpr
        ├── Scheduler          # 只看 nextRunAt；到期调 try_run
        └── try_run / execute_job
              └── runtime.rs   enqueue_cron | 抢 running + run_turn
                    └── RpcClient  thread_* / turn_*
```

职责：

| 层 | 做什么 | 不做什么 |
|----|--------|----------|
| Store | CRUD、`MarkRun`、原子写 | 不实现排队 |
| schedule.rs | 校验 cron、`upcoming(now)`、`plugin_schedule_to_cron` | 不调 App Server |
| Scheduler | sleep 到 `nextRunAt`、到期 `try_run`、CRUD wakeup | 不直接 `turn/start` |
| `try_run` | idle 且 chat 空 → 交给 drain/`execute_job`；否则 `enqueue_cron` 并推进 `nextRunAt` | 不自建 FIFO |
| `execute_job` | 只由 **drain 已抢到 `running`** 之后调用：resume/start thread + `run_turn`；结束必须 `schedule_drain` | 不走 `start_turn` 的 chat 入队分支 |
| runtime | `cron_queue`、去重、drain 一次一条、chat 优先 | 见 PendingQueue |

时钟只有：`min(job.nextRunAt)` + 最长 60s 心跳。排队权威在 `runtime.rs`。

RPC-WIRE §3.3：定时任务 → `cron.rs`（本地）。排队 → `runtime.rs`。

---

## 5. 产品行为

### 5.1 UI

侧栏「已安排」打开独立页（对齐 `PluginsPage`）：

- 列表：名称、节奏文案（cron 人性化或原文）、下次时间、开关、最近 run 状态。
- 新建/编辑：名称、prompt、绑定项目、可选 model；周期用快捷项或手填 cron；**跑在哪**见 §5.2。提交只写 `cronExpr`。
- 立即跑一次、跳转最近 `threadId`、删除。
- 空态写明：应用在跑才会触发；关掉会跳过错过的点。

不把 CronJob 行混进「项目 / 最近」。每次 run 的 Thread 仍按现有规则出现在会话树，标题用任务名（`thread/name/set`）。

Composer 不编辑周期任务。

### 5.2 跑在哪

都在同一个本地项目里跑（`projectId` → cwd）。先选「从哪来」，「项目下新开」再选后续怎么跑：

```text
跑在哪
├── 已有对话（bindExisting）     → 每次 resume 用户指定的 threadId
└── 项目下新开（newInProject）
      ├── 后续每次新开（alwaysNew）     → 每次 thread/start
      └── 后续接着第一次（reuseFirst） → 第一次 start，之后 resume 那条
```


| 组合                            | 第一次                            | 第二次及以后                    | 适用              |
| ----------------------------- | ------------------------------ | ------------------------- | --------------- |
| `newInProject` + `alwaysNew`  | `thread/start`                 | 再 `start`，侧栏多一条           | 每次独立的日报         |
| `newInProject` + `reuseFirst` | `thread/start`，记下 `threadId`   | `thread/resume(threadId)` | 任务自己开一局，后面都在这局续 |
| `bindExisting`                | `thread/resume(用户选的 threadId)` | 同上                        | 挂在用户已经在聊的那条上    |


`reuseFirst` 在第一次跑完之前 `threadId` 为空，这是正常的，不是配置错误。

会话没了：

- `alwaysNew`：无所谓，再 start。
- `reuseFirst`：任务自己生的桩没了 → **再 start 一条并改绑** `threadId`（记一条 warning 即可）。
- `bindExisting`：用户指定的会话没了 → **error**，不偷偷新开。用户改绑或改成项目下新开。

`projectId` 与 Thread 的 cwd 一致；`bindExisting` 用会话反填项目。

### 5.3 无人值守与审批

| 项 | 默认 | 说明 |
|----|------|------|
| sandbox | 可覆盖，默认跟全局 | 限制工作区，禁止「never + 全盘」 |
| approval | 任务上默认 `never` | 无人值守不弹窗 |
| 仍出现审批 | `onNeedsApproval=skip` | interrupt，记 `lastError`；审批只挡**当前**轮，不挡入队 |
| 「立即跑」 | 走 `try_run(manual=true)` | 不改周期 `nextRunAt`；busy 则 `enqueue_cron`，UI 提示将在当前对话结束后执行 |

焦点：Cron `newInProject` 或 drain 到别的 session **不**切主界面（PendingQueue §2.6）。

### 5.4 对接 Pending Queue

细节与状态机以 [PendingQueue.md](./PendingQueue.md) **§0 / §2 / §4.2** 为准。本文件只写 Cron 侧怎么调。

**禁止：**

- `running == true` 时 `turn/start`（会并进当前轮，不是排队）。
- cron 自己维护 FIFO，或插到 `chat_queue` 前面。
- 在 `turn/completed` 回调里循环跑完整个 `cron_queue`。
- `execute_job` 走 `start_turn`（那会进 **chat** 车道）。

**`try_run(job)`（Scheduler / 立即跑）：** 只入队 + 叫醒 drain，**自己不** `turn/start`。

```text
!enabled → return
enqueue_cron(jobId)     // 已在队 → no-op；否则 push，emit codex:queue
周期且非 manual → 推进 nextRunAt（认领这一拍；已在队的 no-op 不再推第二次）
schedule_drain          // idle 则立刻 pop 执行；busy 则等
```

**drain 轮到 cron 时（runtime，一次一条）：**

```text
抢 running 失败 → CronPending push_front 放回，等下次
成功 → execute_job(job)
execute_job 结束（ok / error / 超时 interrupt / thread 失败）
  → running=false
  → 必须 schedule_drain   // Cron 不一定走 start_turn 的 completed
```

**`execute_job`：** 假定已经持有 `running`。做 thread resume/start + `run_turn`（与 chat 同一条发 RPC 的底层，`origin=scheduled`）。超时 `timeoutMins` → `turn/interrupt`。不要再判断 busy、不要自己 drain 整队。

队列不进 `jobs.json`。关应用丢；启动漏触发仍补最多 1 次。已安排页可听 `codex:queue.cron` 显示「排队中」。

---

## 6. 数据模型

路径：`store::get_data_root()/cron/jobs.json`（可仍用单文件 `scheduled-tasks.json`，二选一，实现时定一个）。不进 Git、不进 App Server。

写入必须 **tmp + rename**（`store.rs` 现有 `write_json_file` 是直接 `fs::write`，CronStore 不要沿用；可顺手给 store 加 `atomic_write_json`）。

```ts
type Origin = "newInProject" | "bindExisting";
type Repeat = "alwaysNew" | "reuseFirst"; // 仅 origin=newInProject

interface CronJob {
  id: string;                 // 本机 uuid
  name: string;
  prompt: string;             // v1 必填；不做 exec
  cronExpr: string;           // 5 字段：分 时 日 月 周，本地时区；周期任务必填
  onceAt: string | null;      // ISO-8601；后置一次性。与 cronExpr 互斥
  enabled: boolean;
  projectId: string | null;   // cwd；newInProject 用；bindExisting 从会话反填
  threadId: string | null;    // bindExisting 创建时必填；reuseFirst 第一次跑完才有
  origin: Origin;
  repeat: Repeat | null;      // newInProject 必填；bindExisting 为 null
  model: string | null;
  sandbox: string | null;
  approvalPolicy: string;     // 默认 "never"
  timezone: "local";
  timeoutMins: number;        // 默认 30；0 = 不限（v1 不要 0）
  source?: {
    kind: "user" | "plugin";
    pluginId?: string;
    pluginTaskKey?: string;
  };
  lastThreadId: string | null; // 最近一次实际跑到的 thread；查看跳转用
  lastRunAt: string | null;
  lastStatus: "ok" | "skipped" | "error" | null;
  lastError: string | null;
  nextRunAt: string | null;   // sleep 缓存，由 cronExpr/onceAt 算出；disabled / 已完成 once 为 null
  createdAt: string;
  updatedAt: string;
}

interface CronStoreFile {
  version: 1;
  jobs: CronJob[];
}
```

不存插件那份 `ScheduledTaskSchedule` 对象。插件 / UI 快捷项只在写入时变成 `cronExpr`。不存 run 全文；对话在 App Server Thread。

### 6.1 插件 schedule → cron

UNIX 5 字段，`dow`：`0=日 … 6=六`（`SU=0`，`MO=1`，…，`SA=6`）。`time` 为 `"HH:MM"`。


| `ScheduledTaskSchedule`                                   | `cronExpr` 示例   |
| --------------------------------------------------------- | --------------- |
| `{ type: "daily", time: "09:00" }`                        | `0 9 * * *`     |
| `{ type: "weekdays", time: "09:00" }`                     | `0 9 * * 1-5`   |
| `{ type: "weekly", days: ["MO","WE"], time: "09:30" }`    | `30 9 * * 1,3`  |
| `{ type: "hourly", intervalHours: 2 }`                    | `0 */2 * * *`   |
| `{ type: "hourly", intervalHours: 2, days: ["MO","FR"] }` | `0 */2 * * 1,5` |


`intervalHours < 1`、weekly 无 `days`、`time` 非法 → 转换失败，不写盘。

转换是单向的：jobs.json 里只有 cron，列表用库或简单规则做人性化展示，不要求能反解回 hourly。

校验（upsert 失败则不写盘）：

- `cronExpr` 能被库 parse（v1 周期任务必填）
- prompt / name 非空
- `newInProject`：`repeat` 必为 `alwaysNew` 或 `reuseFirst`；创建时 `threadId` 必须为空；`projectId` 可空（默认目录）
- `bindExisting`：`threadId` 必填，`repeat` 为 null；`projectId` 与该会话所属项目一致
- v1 拒绝 `onceAt`

---

## 7. 调度与执行

### 7.1 Scheduler

启动时机：`ensure_connected` 成功之后 `Scheduler::start`。

1. 读 Store；对每个 `enabled` 且 `nextRunAt==null` 的周期任务，用库对 `cronExpr` 取 `upcoming(now)` 写入 `nextRunAt`。
2. 漏触发见 7.2。
3. sleep 到 `min(nextRunAt)`，上限 60s。
4. 到期 `try_run`（不是直接 `execute_job`）。
5. upsert / enable / delete 发 wakeup，打断 sleep。删除 job 时若在 `cron_queue`，runtime 按 `jobId` 去掉该项（PendingQueue 未写专门 API 则接入时加 `cancel_cron_pending(jobId)`）。

`nextRunAt` 是 sleep 用的缓存，**权威仍是 `cronExpr`**（时区、夏令时以库 + 本地 TZ 为准，upsert 时重算）。

### 7.2 漏触发

周期（v1）：

- 启动或心跳发现 `nextRunAt <= now`：**只跑 1 次**，然后从 now 算下一点。
- 不补历史队列。空态文案与此一致。

once（后置，预留）：

- 过期 ≤ 5min：立刻跑。
- 更久：标 error `missed`，不再跑。

### 7.3 `execute_job`（仅 drain 调用）

Agent 看不到 cron method。`origin=scheduled`：审批按 §5.3 skip；不切 UI 焦点。

```text
// 调用方已 running=true
cwd ← projectId
bindExisting 或 (reuseFirst 且 threadId 已有)
    → thread/resume(threadId)
    → 失败且 reuseFirst → thread/start，写回 threadId
    → 失败且 bindExisting → lastStatus=error；清 running；schedule_drain；结束
alwaysNew 或 reuseFirst 尚无 threadId
    → thread/start；name/set；reuseFirst 则写入 threadId
run_turn(prompt, 任务上的 approval/sandbox/model)   // 禁止 start_turn
等待 completed | error | interrupt
  超时 → turn/interrupt
写 lastThreadId / lastRunAt / lastStatus
emit("codex:scheduled", { jobId, threadId, status })
清 running；schedule_drain
```

### 7.4 Tauri commands


| command                    | 作用                         |
| -------------------------- | -------------------------- |
| `list_cron_jobs_cmd`       | 读 Store                    |
| `upsert_cron_job_cmd`      | 校验、算 `nextRunAt`、写盘、wakeup |
| `delete_cron_job_cmd`      |                            |
| `set_cron_job_enabled_cmd` |                            |
| `run_cron_job_now_cmd`     | `manual=true`              |


前端：`types` + `api.ts` + `ScheduledTasksPage`；Sidebar 去掉 disabled。

---

## 8. 协议边界（只读模板）

当前 schema：无 `scheduledTask/list`；`sourceKinds` 无 scheduled。

可复用的只有 `plugin/read` → `scheduledTasks`：

- `null`：元数据不可用
- `[]`：没有
- 非空：`key/name/prompt/schedule`，**不是**已启用任务

v1 手填 cron 或快捷项。v2 接 `plugin/read`（走 RPC-WIRE），「添加到已安排」：`name`/`prompt` 原样拷贝，`schedule` 经 `plugin_schedule_to_cron` 写成 `cronExpr`，并记下 `source.pluginTaskKey`。

不要为 cron 再包 JSON-RPC。

---

## 9. 分波


| 波次       | 内容                                                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **v1（已做）** | CronStore、cron 库、三种跑法、已安排页、Scheduler + `try_run`；cron 车道按 PendingQueue 接入同一 drain |
| **v1.1（已做）** | 已安排页听队列快照；人性化 cron；`atomic_write_json`；删 job 同步 `cancel_cron_pending` |
| **v2** | `plugin/read` → `plugin_schedule_to_cron` |
| **后置** | `onceAt`；Login Item |
| **不做** | cron 自建队列；busy 时 `turn/start` / `turn/steer`；Exec shell；任务进 App Server |


文件留 `version`，若上游日后加 RPC 再迁。

---

## 10. 测试

- 非法 `cronExpr` → upsert 失败。
- `plugin_schedule_to_cron` 单测：上表每一行。
- `upcoming`：`0 9 * * *` 在 08:59 / 09:01 / 跨日（固定 TZ）。
- misfire：把 `nextRunAt` 拨到过去，启动后只多一条 Thread。
- 用户 Turn 进行中到期 → `cron_queue` 1 条；结束后先跑完 chat 车道再跑该 job；两个 turn id。
- chat 排队一句 + Cron 到期 → 先用户句，再 Cron（PendingQueue §8）。
- 同一 job 到期两次且一直 busy → cron 车道仍 1 条；`nextRunAt` 已往前。
- idle 且 chat 空到期 → 不入队，直接 `execute_job`。
- `running` 时若误 `turn/start` 会并进当前轮 → 对接回归禁止这条路径。
- `never` 不弹 `codex:approval`；若出现则 skip 当前 Cron 轮，然后 `schedule_drain`。
- 超时：mock 不结束的 turn，30min 前用测试用短 timeout 断言 interrupt。
- 私有网关与手聊同一 settings。

手动：应用开着等到下一分钟；关掉错过一点再打开，只补一次。

---

## 11. 文档

- 本文件是 Cron 产品；排队契约以 [PendingQueue.md](./PendingQueue.md) 为准，冲突时以 PendingQueue 为准。
- 聊天里由 Agent 创建/改任务：走通用桌面工具总线 [DynamicTools.md](./DynamicTools.md) 的 `cron` 示例。Composer 仍不直接编辑周期任务。
- 接 `plugin/read` 后：清单改为已接，「可用于已安排模板」。
- Product「无独立 Task 对象」仍指 composer，不指侧栏「已安排」。待办（`plugin/read` 模板、`onceAt`、Login Item）见 [ROADMAP.md](./ROADMAP.md)。


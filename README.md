# Codex Work

Tauri + Vite + React 桌面客户端。真正 spawn **`codex app-server`**，经 **stdio JSON-RPC（JSONL）** 与 Codex harness 通信。

## 架构

```text
React UI
   │  Tauri invoke / events
   ▼
Rust CodexRuntime
   │  JSON-RPC over stdio
   ▼
codex app-server   （子进程）
   │
   ▼
Provider（OpenAI / 内网网关 / Azure …）
```

启动时：

1. 使用锁定的 Codex CLI 版本（`src-tauri/CODEX_VERSION`，与 `package.json` 的 `@openai/codex` 一致）。`npm install` / `npm run dev` / `npm run build` 会从 npm 同步到 `src-tauri/codex-runtime/`，打包时打进应用，运行时不再下载
2. 若设置了 `codexBin`，则改用该路径（仅开发覆盖）
3. `codex app-server --listen stdio://`，并用 `-c` 注入 `model` / `model_provider=codex-work` / `base_url`
4. `initialize` → `initialized` 握手
5. 会话走 App Server：`thread/list` / `thread/read` / `thread/name/set`；发消息 `thread/start|resume` → `turn/start`
6. 项目是客户端本地目录，按 Thread 的 `cwd` 归组
7. 监听 `item/*` / `turn/*` 通知；审批走 `item/commandExecution/requestApproval` 等 ServerRequest

## 快速开始

前置：**Rust 工具链**、**Node.js**。Codex CLI **不必**预先安装；`npm install` 会拉取锁定版本。完整的本地运行、日志、数据目录、生产打包与发版说明见 [`docs/DEVELOP.md`](./docs/DEVELOP.md)。

```bash
npm install
npm run dev
```

## GitHub Actions（macOS 打包）

推送到 `main`、打 `v*` 标签，或在 Actions 里手动 **Run workflow**，会在 `macos-latest` 上分别打 **Apple Silicon**（`darwin-arm64`）和 **Intel**（`darwin-x64`）的 `.app` / `.dmg`。

产物在 workflow 的 Artifacts。推送 `v*` 标签时还会创建 **draft Release**。未配置 Apple 开发者证书，使用 ad-hoc 签名；别人首次打开可能要「右键 → 打开」。

## 配置

| 参数 | 含义 |
|------|------|
| **baseUrl** | Provider API 根路径，启动时注入为 Codex `model_providers.codex-work.base_url` |
| **apiKey** | 注入环境变量 `CODEX_WORK_API_KEY` / `OPENAI_API_KEY` |
| **model** | 传给 `thread/start` / `turn/start` |
| **codexBin** | 可选开发覆盖。留空则使用 npm 同步并打包的锁定版本 |

> Codex 当前要求 `wire_api = "responses"`。仅支持 Chat Completions 的网关可能需要前置兼容层。

## 协议参考

本仓库可用本机 Codex 生成协议 schema：

```bash
codex app-server generate-json-schema --out src-tauri/schemas
python3 scripts/generate-rpc-types.py
```

Rust 类型（method 枚举 + 已接线 Params/审批 Response）由第二步生成到 `src-tauri/src/app_server/generated/`。不要手改该目录。

升级锁定的 Codex 版本：同时改 `src-tauri/CODEX_VERSION` 和 `package.json` 的 `@openai/codex` 版本，用该版本重新导出 schema 并生成类型，然后 `npm install`。

关键方法：`initialize` / `thread/list` / `thread/read` / `thread/name/set` / `thread/start` / `thread/resume` / `turn/start` / `turn/interrupt`  
关键通知：`turn/started` / `item/agentMessage/delta` / `item/started` / `item/completed` / `turn/completed`  
审批：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval` → `{ decision: "accept"|"decline" }`  
未实现的 ServerRequest 回 JSON-RPC error `-32601`（不再误发 `{ decision: "decline" }`）。

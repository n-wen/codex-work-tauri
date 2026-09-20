# Codex Work 开发与发布

本仓库根目录即应用代码。Tauri 2 + Vite + React；运行时 spawn 锁定版本的 `codex app-server`。架构与协议见 [`README.md`](../README.md) 与本目录其它文档。

## 前置

| 工具 | 说明 |
|------|------|
| **Node.js** | 建议 20+；包管理用 **npm**（本应用未锁 pnpm） |
| **Rust** | `rustup` 默认稳定版即可（Tauri 2 需要较新的 rustc） |
| **平台依赖** | [Tauri 2 前置条件](https://v2.tauri.app/start/prerequisites/)：macOS 需 Xcode Command Line Tools；Windows 需 WebView2 + MSVC；Linux 需 webkit2gtk 等 |

不必预先安装 Codex CLI。`npm install` / `npm run dev` / `npm run build` 会把 `src-tauri/CODEX_VERSION` 对应的 `@openai/codex` 同步到 `src-tauri/codex-runtime/`，开发与打包都走这份目录。

## 本地运行

```bash
npm install
npm run dev
```

`npm run dev` 会：

1. `predev`：同步 Codex runtime
2. 通过 `scripts/dev-with-log.mjs` 启动 `tauri dev`，stdout/stderr 同时写入 `logs/dev.log`

前端 Vite 固定端口 **1420**（占用则启动失败）。首次会编译 Rust，可能较慢。

其它脚本：

```bash
npm run dev:tauri          # 不写 logs/dev.log，直接 tauri dev
npm run typecheck          # 前端 tsc
npm run test:codex-runtime # 同步 Codex 包的脚本测试
```

看开发日志：

```bash
tail -f logs/dev.log
```

Rust 侧测试（在 `src-tauri`）：

```bash
cd src-tauri
cargo test
```

### 首次使用

应用内填写 **baseUrl / apiKey / model**。示例见 [`settings.example.json`](../settings.example.json)。

本地数据（设置、项目、会话、定时任务、动态工具配置）在系统用户数据目录，**不要提交 git**：

| 系统 | 路径 |
|------|------|
| macOS | `~/Library/Application Support/io.github.n-wen.codex-work/codex-work/` |
| Linux | `~/.local/share/io.github.n-wen.codex-work/codex-work/` |
| Windows | `%APPDATA%\io.github.n-wen.codex-work\codex-work\` |

可选开发覆盖：设置里的 `codexBin` 指向本机 Codex 可执行文件；留空则用已同步的锁定版本。

当前 Codex 要求 `wire_api = "responses"`。只提供 Chat Completions 的网关可能需要前置兼容层。

## 发布构建

macOS 可用 GitHub Actions 自动打包：`.github/workflows/macos.yml`。推送 `main`、手动 `workflow_dispatch`，或打 `v*` 标签。CI 会分别构建 `aarch64-apple-darwin` 与 `x86_64-apple-darwin`，并用 `CODEX_NPM_PLATFORM` 同步对应架构的 Codex CLI。产物上传为 Artifacts；`v*` 标签会创建 draft Release。

本机发布仍是 `tauri build`。在目标操作系统上原生编译（跨编译还要交叉同步对应平台的 Codex vendor，见下文）。

```bash
npm install
npm run build
```

`prebuild` 会同步 Codex runtime。随后 `tauri build` 构建前端、release Rust，并按 `bundle.targets: "all"` 打当前平台的安装/分发包。

应用依赖旁边的 `codex-runtime`（锁定的 Codex CLI），不能收成一个自包含 exe。因此 Windows 走 Tauri 默认的 **NSIS / MSI 安装包**，把 exe 和资源装到同一目录；不要只拷 `target/release/codex-work.exe` 给别人。

产物在：

```text
src-tauri/target/release/bundle/
```

| 平台 | 产物 | 能不能直接当应用跑 |
|------|------|-------------------|
| macOS | `macos/Codex Work.app` | 可以。双击或 `open`。未签名时可能要「右键 → 打开」 |
| macOS | `dmg/*.dmg` | 不行。先挂载，把里面的 `.app` 拖走再开。这是分发包 |
| Windows | `nsis/*-setup.exe`（可能还有 MSI） | 不行。这是安装程序，装完后从开始菜单启动；安装器会带上 `codex-runtime` |
| Linux | `appimage/` | 可以。`chmod +x` 后直接执行（资源打在镜像里） |
| Linux | `deb/`、`rpm/` | 不行。先用包管理器安装 |

给别人用：macOS 发 **dmg**，Windows 发 **NSIS setup.exe**，Linux 发 **AppImage** 或 **deb/rpm**。安装包会把 `codex-runtime/**` 打进去，运行时**不再**从网络下载 Codex CLI。

产物必须在**对应 OS + CPU** 上构建。只要某一种包（例如只要 dmg）：`npx tauri build --bundles dmg`。

### 版本号

发版前同步这三处（当前为 `0.1.0`）：

- `package.json` 的 `version`
- `src-tauri/tauri.conf.json` 的 `version`
- `src-tauri/Cargo.toml` 的 `package.version`

`identifier` 为 `io.github.n-wen.codex-work`，改 bundle id 会影响用户数据目录。

### 签名与公证

macOS 使用 ad-hoc 签名（`bundle.macOS.signingIdentity` 为 `-`），没有 Apple 开发者证书。别人打开可能被 Gatekeeper 拦截（可「右键 → 打开」，或自行配置 `APPLE_*` / `TAURI_SIGNING_*` 后再构建）。Windows SmartScreen 同理。

### 交叉同步 Codex CLI

`codex-runtime` 默认跟**当前 Node 的 platform/arch**。若在 A 平台为 B 平台打资源，可覆盖：

```bash
# 例：在 darwin-arm64 上准备 win32-x64 的 vendor（仍需对应的 Rust 交叉编译环境）
CODEX_NPM_PLATFORM=win32-x64 node scripts/sync-codex-runtime.mjs
```

支持的 key：`darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64`、`win32-x64`、`win32-arm64`。

常规发版建议：**在目标机器上 `npm run build`**，避免交叉编译和 vendor 架构不一致。

## 升级锁定的 Codex

1. 同时改 `src-tauri/CODEX_VERSION` 与 `package.json` 里 `@openai/codex` 的版本（必须一致）
2. 用该版本导出 schema 并生成 Rust 类型：

```bash
codex app-server generate-json-schema --out src-tauri/schemas
python3 scripts/generate-rpc-types.py
```

3. `npm install` 重新同步 `codex-runtime/`

`src-tauri/src/app_server/generated/` 为生成代码，不要手改。

## 相关文档

| 文档 | 内容 |
|------|------|
| [Product.md](./Product.md) | 产品范围与非目标 |
| [ROADMAP.md](./ROADMAP.md) | 已完成能力与待办 |
| [RPC-WIRE.md](./RPC-WIRE.md) | 如何对接一条 RPC |
| [RPC-INVENTORY.md](./RPC-INVENTORY.md) | 已接线 RPC 清单 |
| [JSON-RPC.md](./JSON-RPC.md) | JSON-RPC 约定 |
| [DynamicTools.md](./DynamicTools.md) | 动态工具 |
| [ScheduledTask.md](./ScheduledTask.md) | 定时任务 |
| [PendingQueue.md](./PendingQueue.md) | 待处理队列 |

# Codex Work
*Open Codex Desktop*

An open-source desktop client for Codex, designed for private, restricted, and enterprise environments.

## 1. Product

Open Codex Desktop is a native desktop application that provides a user experience similar to Codex Desktop while allowing organizations and developers to connect Codex to custom infrastructure, internal AI gateways, and private development environments.

The application is a **client**, not a replacement for the Codex agent runtime.

The primary runtime is OpenAI's open-source Codex App Server.

## 2. Goals

### Primary goals

* Provide a desktop experience similar to Codex Desktop.
* Work in private and restricted network environments.
* Support custom OpenAI-compatible API endpoints.
* Allow organizations to use internal AI gateways.
* Keep user projects and sessions local by default.
* Preserve the native Codex Agent experience.
* Avoid reimplementing the Codex agent runtime.

### Secondary goals

* Support internal MCP servers.
* Support internal Skills.
* git/diff
* terminal


## 3. Non-goals

The project will not initially:

* Implement its own coding agent.
* Implement its own LLM orchestration layer.
* Replace Codex App Server.
* Implement a cloud backend.
* Require user accounts.
* Provide team collaboration.
* Provide cloud session synchronization.
* Provide an AI model marketplace.
* Become a general-purpose IDE.

## 4. Target users

### Primary

Developers who use Codex in:

* private networks
* enterprise environments
* restricted networks
* air-gapped or partially isolated environments
* environments with internal AI gateways
* environments requiring custom API endpoints

### Secondary

Developers who want:

* an open-source Codex Desktop alternative
* a customizable Codex client
* local control over their development environment

## 5. Core workflow

The Codex App experience is **session-first**, not project-first.

The primary user path is:

```text
New chat（新对话）
    ↓
Describe the work in the composer（直接开聊）
    ↓
Agent executes（tools / commands / approval）
    ↓
Review results / diff
    ↓
Continue the conversation or commit
```

Opening a project is **not** a required first step. A project is an organizational grouping in the sidebar (a workspace / directory). The user can start chatting immediately; the session may later appear under a project (for example `dev`) or under Recents（最近）.

There is no separate Task object in the UI. Sending the first message *is* describing the task.

Internally this still maps onto App Server concepts (Project / Thread / Turn). The desktop application should make that mapping invisible in everyday use.

The desktop application should make this workflow feel natural and continuous.

## 6. Core concepts

Surface language should follow the Codex App. Protocol and implementation language may keep Thread / Project.

| UI (user-facing) | Internal / App Server |
|---|---|
| 新对话 / session / conversation | Create Thread |
| A titled row under 项目 or 最近 | Thread（会话） |
| 项目（e.g. `dev`） | Project（workspace / cwd / Git repo） |
| One user message | Start of a Turn（文档里的 Describe Task） |
| Agent reply + tool cards + 请求批准 | Agent / Tool Execution / Approval |

### Project

A local development workspace, usually a directory or Git repository.

In the UI it is a **sidebar grouping**, not a mandatory gate. Sessions belonging to the same workspace appear under that project. Sessions without a strong project association appear under Recents.

### Thread（会话）

A persistent Codex conversation. In the UI this is a **session / chat**.

A thread can be:

* created（新对话）
* resumed（从侧边栏打开）
* forked
* archived
* deleted
* renamed（often from the first user message）

### Turn

One user request and the resulting Codex execution.

### Item

A unit of work or output inside a turn.

Examples:

* user message
* agent message
* reasoning
* shell command
* command output
* file change
* MCP tool call
* approval request

### Agent

The Codex runtime executing the current thread.

The desktop application should treat the Agent as an external runtime rather than embedding agent logic into the UI.

## 6.1 Desktop UI (Codex App reference)

Layout:

```text
┌────────────┬──────────────────────────────────────┐
│  Sidebar   │           Main session                │
│            │  Title                                │
│  Nav /     │  Message stream                       │
│  organize  │  Composer                             │
└────────────┴──────────────────────────────────────┘
```

### Sidebar

* Header: workspace / mode switcher（e.g. 工作）, search, notifications.
* Primary action: **新对话** — create a session and start chatting.
* Secondary entries: 已安排, 插件.
* **项目**: workspace folders; each child row is a session in that project.
* **最近**: global / ungrouped recent sessions.
* Footer: account / environment.

The highlighted sidebar row is the current Thread.

### Main session

* Title bar: session title (often the first user message) plus overflow and layout controls.
* Message stream: agent text, status lines, tool/result cards (commands run, local preview, “Open in Codex”, file-path pills).
* Composer:
  * `+` for attachments / extra context
  * 请求批准 for command / file-write approval
  * text field (placeholder such as “使用 ChatGPT Work”)
  * model / reasoning controls（e.g. 自定义, 高）
  * send

The composer is the only “task” surface. Users do not fill a separate task form.

## 7. Desktop capabilities

### Project

* Open project
* Create project
* Recent projects
* Project settings

### Threads

* Create thread
* Resume thread
* Fork thread
* Archive thread
* Delete thread
* Rename thread
* Search threads

### Agent

* Send message
* Stream response
* Interrupt execution
* Display tool calls
* Display command output
* Display file changes
* Handle approval requests
* Display errors

### Code

* File tree
* Diff viewer
* Changed files
* Open file
* Reveal file in system file manager

### Development

* Integrated terminal
* Git status
* Git diff
* Git branch
* Commit changes

### Configuration

* Model
* Model provider
* API endpoint
* API credentials
* Approval policy
* Sandbox policy
* Reasoning effort
* MCP
* Skills

## 8. Private deployment

The application must not require OpenAI infrastructure to function as a desktop client.

The connection architecture should support:

```text
Desktop
   │
   ▼
Codex App Server
   │
   ▼
Provider
   │
   ├── OpenAI
   ├── Internal AI Gateway
   ├── Azure OpenAI
   └── Other compatible providers
```

The desktop client should not assume that the provider is publicly accessible.

## 9. Local-first

By default:

* source code remains local
* thread history remains local
* Git information remains local
* configuration remains local
* credentials remain local

The application should not introduce a mandatory cloud service.

## 10. Open-source principle

The desktop client itself should be fully open source.

The project should avoid architectural dependencies on proprietary desktop components whenever practical.

The Codex runtime remains an external dependency provided by the upstream Codex project.

## 11. Compatibility

The desktop client should communicate with Codex through the App Server protocol rather than depending on undocumented internals of the Codex CLI.

The App Server protocol is the primary integration boundary.

## 12. MVP

The first release should implement only:

### Workspace

* Open project
* Recent projects

### Thread

* Create
* Resume
* Fork
* Archive
* Delete

### Chat

* User message
* Agent streaming message
* Turn state

### Tools

* Command execution
* File changes
* Tool status

### Approval

* Command approval
* File change approval

### Code

* Changed files
* Unified diff

### Runtime

* Codex App Server
* Local configuration
* Custom provider endpoint

### Platform

* macOS
* Windows

Linux support should follow once the core architecture is stable.

Implementation status and remaining work: [ROADMAP.md](./ROADMAP.md).

## 13. Success criteria

A user should be able to:

1. Install the application.
2. Start a new chat without first creating a project.
3. Describe work in the composer and send a message.
4. Watch the agent execute tools.
5. Approve or reject operations.
6. Review the resulting diff.
7. Continue the conversation.
8. See the session listed under Recents or under a project.
9. Close the application.
10. Reopen the app and resume the same session.

If these workflows work reliably, the MVP is successful.

## 14. Product principle

The application should be boring.

It should not try to reinvent the coding agent.

Its job is to provide an excellent desktop interface around the agent runtime.

> **The Agent thinks.
> The App presents, controls, and protects.**

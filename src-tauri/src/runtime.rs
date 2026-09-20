use crate::app_server::generated::agent_message_delta_notification::AgentMessageDeltaNotification;
use crate::app_server::generated::command_execution_approval_response::{
    CommandExecutionApprovalDecision, CommandExecutionApprovalDecisionLiteral,
    CommandExecutionRequestApprovalResponse,
};
use crate::app_server::generated::dynamic_tool_call_params::DynamicToolCallParams;
use crate::app_server::generated::dynamic_tool_call_response::DynamicToolCallResponse;
use crate::app_server::generated::file_change_approval_response::{
    FileChangeApprovalDecision, FileChangeApprovalDecisionLiteral,
    FileChangeRequestApprovalResponse,
};
use crate::app_server::generated::{ServerNotificationMethod, ServerRequestMethod};
use crate::app_server::items::{item_to_tool_record, user_message_text};
use crate::app_server::permissions::{AgentPermissions, Permissions};
use crate::app_server::{Incoming, RpcClient};
use crate::host::cron::CronService;
use crate::host::dynamic_tools::{DispatchCtx, DynamicToolConfirmRequest, DynamicTools};
use crate::host::projects::Projects;
use crate::host::settings::Settings;
use crate::types::{now_iso, ResultOrError};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio::sync::Mutex as AsyncMutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexEvent {
    pub jsonrpc: String,
    pub method: String,
    pub params: Value,
}

impl CodexEvent {
    pub fn new(method: &str, params: Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            method: method.into(),
            params,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub request_id: String,
    pub tool_call_id: String,
    pub name: String,
    pub arguments: HashMap<String, Value>,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_summary: Option<String>,
    /// `command` | `fileChange` | `permissions`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_actions: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposed_execpolicy_amendment: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposed_network_policy_amendments: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPending {
    pub id: String,
    pub lane: String,
    pub session_id: String,
    pub project_id: String,
    pub text: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sending_soon: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<NamePathRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<NamePathRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronPending {
    pub id: String,
    pub lane: String,
    pub job_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueueSnapshot {
    pub chat: Vec<ChatPending>,
    pub cron: Vec<CronPending>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTurnInput {
    pub project_id: String,
    pub session_id: String,
    pub message: String,
    /// Client-generated id for optimistic queue bubbles (optional).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_id: Option<String>,
    /// Absolute local image paths for `localImage` inputs.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
    /// Per-session model override (API model id). Empty → settings default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Reasoning effort (`low` / `medium` / `high` / …). Empty → provider default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// Skill attachments: `{ name, path }`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<NamePathRef>,
    /// File mention attachments: `{ name, path }`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<NamePathRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamePathRef {
    pub name: String,
    pub path: String,
}

#[derive(Clone)]
struct ActiveTurn {
    thread_id: String,
    turn_id: String,
}

#[derive(Clone, Copy)]
enum ApprovalKind {
    CommandExecution,
    FileChange,
    Permissions,
}

struct PendingApproval {
    id: Value,
    kind: ApprovalKind,
    /// Echoed on accept for `item/permissions/requestApproval`.
    requested_permissions: Option<Value>,
}

struct PendingDynamicTool {
    id: Value,
    namespace: Option<String>,
    tool: String,
    arguments: Value,
    thread_id: String,
    turn_id: String,
    call_id: String,
    project_id: Option<String>,
}

struct PendingMcpElicitation {
    id: Value,
}

struct PendingToolUserInput {
    id: Value,
}

const CHAT_QUEUE_LIMIT: usize = 20;

pub struct CodexRuntime {
    /// True while any thread has an in-flight turn (cron drain still waits for global idle).
    running: AtomicBool,
    draining: AtomicBool,
    server: AsyncMutex<Option<Arc<RpcClient>>>,
    /// Kept out of `server` so the event pump never holds the client lock while waiting.
    incoming_rx: AsyncMutex<Option<mpsc::UnboundedReceiver<Incoming>>>,
    /// thread_id → turn_id (empty turn_id = start claimed, waiting for turn/started).
    active_turns: Mutex<HashMap<String, String>>,
    /// JSON-RPC request id (stringified) → waiting for UI decision
    pending_approvals: Mutex<HashMap<String, PendingApproval>>,
    pending_dynamic_tools: Mutex<HashMap<String, PendingDynamicTool>>,
    pending_mcp_elicitations: Mutex<HashMap<String, PendingMcpElicitation>>,
    pending_tool_user_inputs: Mutex<HashMap<String, PendingToolUserInput>>,
    /// Project for the turn currently running (chat path).
    active_project_id: Mutex<Option<String>>,
    chat_queue: Mutex<VecDeque<ChatPending>>,
    cron_queue: Mutex<VecDeque<CronPending>>,
    scheduled_job_id: Mutex<Option<String>>,
    pump_started: AtomicBool,
    settings: Arc<Settings>,
    projects: Arc<Projects>,
    app: AppHandle,
    /// Wired after construction to break CronService ↔ Runtime cycle.
    cron: OnceLock<Arc<CronService>>,
    /// Wired after construction; DynamicTools does not hold Runtime.
    dynamic_tools: OnceLock<Arc<DynamicTools>>,
}

impl CodexRuntime {
    pub fn new(app: AppHandle, settings: Arc<Settings>, projects: Arc<Projects>) -> Self {
        Self {
            running: AtomicBool::new(false),
            draining: AtomicBool::new(false),
            server: AsyncMutex::new(None),
            incoming_rx: AsyncMutex::new(None),
            active_turns: Mutex::new(HashMap::new()),
            pending_approvals: Mutex::new(HashMap::new()),
            pending_dynamic_tools: Mutex::new(HashMap::new()),
            pending_mcp_elicitations: Mutex::new(HashMap::new()),
            pending_tool_user_inputs: Mutex::new(HashMap::new()),
            active_project_id: Mutex::new(None),
            chat_queue: Mutex::new(VecDeque::new()),
            cron_queue: Mutex::new(VecDeque::new()),
            scheduled_job_id: Mutex::new(None),
            pump_started: AtomicBool::new(false),
            settings,
            projects,
            app,
            cron: OnceLock::new(),
            dynamic_tools: OnceLock::new(),
        }
    }

    pub fn attach_cron(&self, cron: Arc<CronService>) {
        let _ = self.cron.set(cron);
    }

    pub fn attach_dynamic_tools(&self, tools: Arc<DynamicTools>) {
        let _ = self.dynamic_tools.set(tools);
    }

    pub fn app(&self) -> AppHandle {
        self.app.clone()
    }

    fn cron(&self) -> Arc<CronService> {
        Arc::clone(
            self.cron
                .get()
                .expect("CronService not attached — call AppState::new()"),
        )
    }

    fn dynamic_tools(&self) -> Arc<DynamicTools> {
        Arc::clone(
            self.dynamic_tools
                .get()
                .expect("DynamicTools not attached — call AppState::new()"),
        )
    }

    pub(crate) async fn client(&self) -> Result<Arc<RpcClient>, String> {
        let guard = self.server.lock().await;
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| "App Server 未启动".to_string())
    }

    pub async fn connected_client(self: &Arc<Self>) -> Result<Arc<RpcClient>, String> {
        self.ensure_connected().await?;
        self.client().await
    }

    /// Load a persisted thread into the live App Server before methods that
    /// require an in-memory handle (`thread/compact/start`, `review/start`, …).
    /// `turn/start` already resumes; UI-only open paths only `thread/read`.
    pub async fn ensure_thread_resumed(
        self: &Arc<Self>,
        thread_id: &str,
    ) -> Result<Arc<RpcClient>, String> {
        let tid = thread_id.trim();
        if tid.is_empty() {
            return Err("会话 id 不能为空".into());
        }
        let client = self.connected_client().await?;
        let settings = self.settings.load();
        let model = settings.as_ref().map(|s| s.default_model());
        let perms = Permissions::read_client(&client)
            .await
            .unwrap_or_else(|_| AgentPermissions::default_auto());
        client
            .thread_resume(
                tid,
                &perms.sandbox,
                &perms.approval_policy,
                true,
                model,
            )
            .await
            .map_err(|e| format!("无法恢复会话：{e}"))?;
        Ok(client)
    }

    pub async fn ensure_connected(self: &Arc<Self>) -> Result<(), String> {
        {
            let mut guard = self.server.lock().await;
            let need_start = match guard.as_ref() {
                None => true,
                Some(h) => !h.is_alive(),
            };
            if need_start {
                let settings = self.settings.load().ok_or_else(|| {
                    "尚未配置模型，请先在设置中填写 Provider（baseUrl / apiKey / 模型）".to_string()
                })?;
                let (client, rx) = RpcClient::connect(&settings).await?;
                *guard = Some(Arc::new(client));
                *self.incoming_rx.lock().await = Some(rx);
                self.pump_started.store(false, Ordering::SeqCst);
            }
        }

        // Start incoming pump once per process connection.
        if !self.pump_started.swap(true, Ordering::SeqCst) {
            let this = Arc::clone(self);
            let pump_app = self.app.clone();
            tokio::spawn(async move {
                this.pump_incoming(pump_app).await;
            });
            self.cron().start_scheduler();
        }
        Ok(())
    }

    /// Kill App Server and reconnect with current settings (provider switch).
    pub async fn reconnect(self: &Arc<Self>) -> Result<(), String> {
        {
            let mut guard = self.server.lock().await;
            *guard = None;
        }
        // Dropping RpcClient kills the child (kill_on_drop). Wait briefly for pump to exit.
        self.pump_started.store(false, Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        self.ensure_connected().await
    }

    async fn pump_incoming(self: Arc<Self>, app: AppHandle) {
        let mut rx = match self.incoming_rx.lock().await.take() {
            Some(rx) => rx,
            None => {
                self.pump_started.store(false, Ordering::SeqCst);
                return;
            }
        };

        while let Some(msg) = rx.recv().await {
            match msg {
                Incoming::Notification { method, params } => {
                    Arc::clone(&self).handle_notification(&app, &method, params);
                }
                Incoming::ServerRequest { id, method, params } => {
                    self.handle_server_request(&app, id, &method, params);
                }
            }
        }
        self.pump_started.store(false, Ordering::SeqCst);
    }

    fn emit_event(&self, app: &AppHandle, method: &str, params: Value) {
        let _ = app.emit("codex:event", CodexEvent::new(method, params));
    }

    fn sync_running_flag(&self, turns: &HashMap<String, String>) {
        self.running.store(!turns.is_empty(), Ordering::SeqCst);
    }

    fn thread_busy(&self, thread_id: &str) -> bool {
        let tid = thread_id.trim();
        if tid.is_empty() {
            return false;
        }
        self.active_turns.lock().contains_key(tid)
    }

    /// Claim a thread before `turn/start`. Returns false if already busy.
    pub(crate) fn claim_thread(&self, thread_id: &str) -> bool {
        let tid = thread_id.trim();
        if tid.is_empty() {
            return false;
        }
        let mut turns = self.active_turns.lock();
        if turns.contains_key(tid) {
            return false;
        }
        turns.insert(tid.to_string(), String::new());
        self.sync_running_flag(&turns);
        true
    }

    fn set_thread_turn(&self, thread_id: &str, turn_id: &str) {
        let tid = thread_id.trim();
        let turn = turn_id.trim();
        if tid.is_empty() || turn.is_empty() {
            return;
        }
        let mut turns = self.active_turns.lock();
        turns.insert(tid.to_string(), turn.to_string());
        self.sync_running_flag(&turns);
    }

    pub(crate) fn release_thread(&self, thread_id: &str) {
        let tid = thread_id.trim();
        if tid.is_empty() {
            return;
        }
        let mut turns = self.active_turns.lock();
        turns.remove(tid);
        self.sync_running_flag(&turns);
    }

    fn clear_all_turns(&self) {
        let mut turns = self.active_turns.lock();
        turns.clear();
        self.sync_running_flag(&turns);
    }

    fn active_turn_for(&self, thread_id: &str) -> Option<ActiveTurn> {
        let tid = thread_id.trim();
        if tid.is_empty() {
            return None;
        }
        let turns = self.active_turns.lock();
        let turn_id = turns.get(tid)?.trim();
        if turn_id.is_empty() {
            return None;
        }
        Some(ActiveTurn {
            thread_id: tid.to_string(),
            turn_id: turn_id.to_string(),
        })
    }

    fn any_active_turn(&self) -> Option<ActiveTurn> {
        let turns = self.active_turns.lock();
        turns.iter().find_map(|(tid, turn)| {
            let t = turn.trim();
            if t.is_empty() {
                None
            } else {
                Some(ActiveTurn {
                    thread_id: tid.clone(),
                    turn_id: t.to_string(),
                })
            }
        })
    }

    fn handle_notification(self: Arc<Self>, app: &AppHandle, method: &str, params: Value) {
        match ServerNotificationMethod::from_method(method) {
            Some(ServerNotificationMethod::TurnStarted) => {
                let turn_id = params
                    .pointer("/turn/id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let thread_id = params
                    .get("threadId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if !thread_id.is_empty() && !turn_id.is_empty() {
                    self.set_thread_turn(&thread_id, &turn_id);
                }
                self.emit_event(
                    app,
                    "turn/start",
                    json!({
                        "threadId": thread_id,
                        "turnId": turn_id,
                        "projectId": params.get("projectId"),
                        "sessionId": thread_id,
                    }),
                );
            }
            Some(ServerNotificationMethod::TurnCompleted) => {
                let status = params
                    .pointer("/turn/status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("completed");
                let thread_id = params
                    .get("threadId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                self.release_thread(thread_id);
                self.set_scheduled_job(None);
                let ui_method = if status == "interrupted" {
                    "turn/interrupted"
                } else if status == "failed" {
                    "turn/error"
                } else {
                    "turn/completed"
                };
                let mut out = params.clone();
                if ui_method == "turn/error" {
                    if let Some(obj) = out.as_object_mut() {
                        let err = params
                            .pointer("/turn/error/message")
                            .and_then(|v| v.as_str())
                            .unwrap_or("turn failed");
                        obj.insert("error".into(), json!(err));
                    }
                }
                self.emit_event(app, ui_method, out);
                self.schedule_drain(app.clone());
            }
            Some(ServerNotificationMethod::ItemAgentMessageDelta) => {
                let Ok(delta) = serde_json::from_value::<AgentMessageDeltaNotification>(params)
                else {
                    return;
                };
                self.emit_event(
                    app,
                    ServerNotificationMethod::ItemAgentMessageDelta.as_str(),
                    json!({
                        "messageId": delta.item_id,
                        "itemId": delta.item_id,
                        "sessionId": delta.thread_id,
                        "delta": delta.delta,
                    }),
                );
            }
            Some(ServerNotificationMethod::ItemCommandExecutionOutputDelta) => {
                let item_id = params
                    .get("itemId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let delta = params
                    .get("delta")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if item_id.is_empty() || delta.is_empty() {
                    return;
                }
                self.emit_event(
                    app,
                    "item/commandExecution/outputDelta",
                    json!({
                        "itemId": item_id,
                        "delta": delta,
                        "sessionId": params.get("threadId"),
                        "threadId": params.get("threadId"),
                        "turnId": params.get("turnId"),
                    }),
                );
            }
            Some(ServerNotificationMethod::TurnDiffUpdated) => {
                self.emit_event(
                    app,
                    "turn/diff/updated",
                    json!({
                        "diff": params.get("diff").and_then(|v| v.as_str()).unwrap_or(""),
                        "sessionId": params.get("threadId"),
                        "threadId": params.get("threadId"),
                        "turnId": params.get("turnId"),
                    }),
                );
            }
            Some(ServerNotificationMethod::ItemFileChangePatchUpdated) => {
                let item_id = params
                    .get("itemId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let changes = params.get("changes").cloned().unwrap_or(json!([]));
                let diff_summary = changes
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|c| {
                                let path = c.get("path")?.as_str()?;
                                let diff = c.get("diff").and_then(|d| d.as_str()).unwrap_or("");
                                Some(format!("{path}\n{diff}"))
                            })
                            .collect::<Vec<_>>()
                            .join("\n\n")
                    })
                    .unwrap_or_default();
                self.emit_event(
                    app,
                    "item/fileChange/patchUpdated",
                    json!({
                        "itemId": item_id,
                        "changes": changes,
                        "diffSummary": diff_summary,
                        "sessionId": params.get("threadId"),
                        "threadId": params.get("threadId"),
                        "turnId": params.get("turnId"),
                    }),
                );
            }
            Some(ServerNotificationMethod::ItemStarted) => {
                self.on_item_started(app, &params);
            }
            Some(ServerNotificationMethod::ItemCompleted) => {
                self.on_item_completed(app, &params);
            }
            Some(ServerNotificationMethod::Error) => {
                // Global App Server error — drop all in-flight turn tracking.
                self.clear_all_turns();
                self.set_scheduled_job(None);
                let err = params
                    .pointer("/error/message")
                    .or_else(|| params.get("message"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("App Server error");
                self.emit_event(app, "turn/error", json!({ "error": err }));
                self.schedule_drain(app.clone());
            }
            Some(other) => {
                self.emit_event(app, other.as_str(), params);
            }
            None => {
                self.emit_event(app, method, params);
            }
        }
    }

    fn on_item_started(&self, app: &AppHandle, params: &Value) {
        let item = params.get("item").cloned().unwrap_or(Value::Null);
        let item_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let item_id = item.get("id").and_then(|t| t.as_str()).unwrap_or("");

        match item_type {
            "userMessage" => {
                let text = user_message_text(&item);
                let client_id = item
                    .get("clientId")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                // Image-only / empty text still needs delivery reconcile via clientId.
                if text.is_empty() && client_id.is_none() {
                    return;
                }
                self.emit_event(
                    app,
                    "item/userMessage",
                    json!({
                        "messageId": item_id,
                        "content": text,
                        "clientId": client_id,
                        "sessionId": params.get("threadId"),
                        "threadId": params.get("threadId"),
                    }),
                );
            }
            "agentMessage" => {
                let text = item.get("text").and_then(|t| t.as_str()).unwrap_or("");
                self.emit_event(
                    app,
                    "item/agentMessage/completed",
                    json!({
                        "messageId": item_id,
                        "content": text,
                        "sessionId": params.get("threadId"),
                    }),
                );
            }
            "commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall" => {
                let tool = item_to_tool_record(&item);
                self.emit_event(
                    app,
                    "item/toolCall",
                    json!({
                        "messageId": format!("tools-{}", params.get("turnId").and_then(|v| v.as_str()).unwrap_or("")),
                        "sessionId": params.get("threadId"),
                        "toolCall": tool,
                    }),
                );
            }
            "reasoning" => {
                let summary = item
                    .get("summary")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|s| s.as_str())
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                self.emit_event(
                    app,
                    "item/reasoning",
                    json!({
                        "messageId": item_id,
                        "sessionId": params.get("threadId"),
                        "threadId": params.get("threadId"),
                        "turnId": params.get("turnId"),
                        "summary": summary,
                    }),
                );
            }
            "plan" => {
                let text = item.get("text").and_then(|t| t.as_str()).unwrap_or("");
                self.emit_event(
                    app,
                    "item/plan",
                    json!({
                        "messageId": item_id,
                        "sessionId": params.get("threadId"),
                        "threadId": params.get("threadId"),
                        "turnId": params.get("turnId"),
                        "text": text,
                    }),
                );
            }
            _ => {}
        }
    }

    fn on_item_completed(&self, app: &AppHandle, params: &Value) {
        let item = params.get("item").cloned().unwrap_or(Value::Null);
        let item_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let item_id = item.get("id").and_then(|t| t.as_str()).unwrap_or("");

        match item_type {
            // Idempotent with item/started — covers hosts that only emit completed.
            "userMessage" => {
                let text = user_message_text(&item);
                let client_id = item
                    .get("clientId")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                if text.is_empty() && client_id.is_none() {
                    return;
                }
                self.emit_event(
                    app,
                    "item/userMessage",
                    json!({
                        "messageId": item_id,
                        "content": text,
                        "clientId": client_id,
                        "sessionId": params.get("threadId"),
                        "threadId": params.get("threadId"),
                    }),
                );
            }
            "agentMessage" => {
                let text = item.get("text").and_then(|t| t.as_str()).unwrap_or("");
                self.emit_event(
                    app,
                    "item/agentMessage/completed",
                    json!({
                        "messageId": item_id,
                        "content": text,
                        "sessionId": params.get("threadId"),
                    }),
                );
            }
            "commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall" => {
                let tool = item_to_tool_record(&item);
                self.emit_event(
                    app,
                    "item/toolCall/updated",
                    json!({
                        "messageId": format!("tools-{}", params.get("turnId").and_then(|v| v.as_str()).unwrap_or("")),
                        "sessionId": params.get("threadId"),
                        "toolCall": tool,
                    }),
                );
            }
            "reasoning" => {
                let summary = item
                    .get("summary")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|s| s.as_str())
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                self.emit_event(
                    app,
                    "item/reasoning",
                    json!({
                        "messageId": item_id,
                        "sessionId": params.get("threadId"),
                        "threadId": params.get("threadId"),
                        "turnId": params.get("turnId"),
                        "summary": summary,
                    }),
                );
            }
            "plan" => {
                let text = item.get("text").and_then(|t| t.as_str()).unwrap_or("");
                self.emit_event(
                    app,
                    "item/plan",
                    json!({
                        "messageId": item_id,
                        "sessionId": params.get("threadId"),
                        "threadId": params.get("threadId"),
                        "turnId": params.get("turnId"),
                        "text": text,
                    }),
                );
            }
            _ => {}
        }
    }

    fn handle_server_request(
        self: &Arc<Self>,
        app: &AppHandle,
        id: Value,
        method: &str,
        params: Value,
    ) {
        let request_id = match &id {
            Value::Number(n) => n.to_string(),
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };

        let parsed = ServerRequestMethod::from_method(method);

        // Dynamic tools: always answer with DynamicToolCallResponse (never {decision}).
        if matches!(parsed, Some(ServerRequestMethod::ItemToolCall)) {
            self.handle_dynamic_tool_call(app, id, params);
            return;
        }

        if matches!(parsed, Some(ServerRequestMethod::McpServerElicitationRequest)) {
            self.pending_mcp_elicitations
                .lock()
                .insert(request_id.clone(), PendingMcpElicitation { id: id.clone() });
            let server_name = params
                .get("serverName")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let message = params
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("MCP 需要你的输入")
                .to_string();
            let mode = params
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("form")
                .to_string();
            let url = params
                .get("url")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let schema = params.get("requestedSchema").cloned();
            let _ = app.emit(
                "codex:mcpElicitation",
                json!({
                    "requestId": request_id,
                    "serverName": server_name,
                    "message": message,
                    "mode": mode,
                    "url": url,
                    "schema": schema,
                }),
            );
            return;
        }

        if matches!(parsed, Some(ServerRequestMethod::ItemToolRequestUserInput)) {
            self.pending_tool_user_inputs
                .lock()
                .insert(request_id.clone(), PendingToolUserInput { id: id.clone() });
            let questions = params
                .get("questions")
                .cloned()
                .unwrap_or_else(|| json!([]));
            let _ = app.emit(
                "codex:toolUserInput",
                json!({
                    "requestId": request_id,
                    "threadId": params.get("threadId"),
                    "turnId": params.get("turnId"),
                    "itemId": params.get("itemId"),
                    "questions": questions,
                    "autoResolutionMs": params.get("autoResolutionMs"),
                }),
            );
            return;
        }

        if self.scheduled_job_id.lock().is_some() {
            let this = Arc::clone(self);
            let method_owned = method.to_string();
            let perms = params.get("permissions").cloned();
            tokio::spawn(async move {
                if let Ok(client) = this.client().await {
                    match ServerRequestMethod::from_method(&method_owned) {
                        Some(ServerRequestMethod::ItemCommandExecutionRequestApproval) => {
                            let result = CommandExecutionRequestApprovalResponse {
                                decision:
                                    CommandExecutionApprovalDecision::CommandExecutionApprovalDecisionLiteral(
                                        CommandExecutionApprovalDecisionLiteral::Decline,
                                    ),
                            };
                            let _ = client.respond_typed(id, &result);
                        }
                        Some(ServerRequestMethod::ItemFileChangeRequestApproval) => {
                            let result = FileChangeRequestApprovalResponse {
                                decision:
                                    FileChangeApprovalDecision::FileChangeApprovalDecisionLiteral(
                                        FileChangeApprovalDecisionLiteral::Decline,
                                    ),
                            };
                            let _ = client.respond_typed(id, &result);
                        }
                        Some(ServerRequestMethod::ItemPermissionsRequestApproval) => {
                            // Decline by granting nothing.
                            let _ = client.respond(
                                id,
                                json!({
                                    "permissions": {},
                                    "scope": "turn",
                                }),
                            );
                            let _ = perms;
                        }
                        _ => {
                            let _ = client.respond_error(id, -32601, "scheduled run auto-decline");
                        }
                    }
                }
            });
            return;
        }

        let mut command_actions: Option<Value> = None;
        let mut proposed_execpolicy: Option<Value> = None;
        let mut proposed_network: Option<Value> = None;
        let mut requested_permissions: Option<Value> = None;
        let mut approval_kind_label = "command".to_string();

        let (name, reason, arguments, kind) = match parsed {
            Some(ServerRequestMethod::ItemCommandExecutionRequestApproval) => {
                let cmd = params.get("command").cloned().unwrap_or(Value::Null);
                let mut args = Map::new();
                args.insert("command".into(), cmd);
                if let Some(cwd) = params.get("cwd") {
                    args.insert("cwd".into(), cwd.clone());
                }
                command_actions = params.get("commandActions").cloned();
                proposed_execpolicy = params.get("proposedExecpolicyAmendment").cloned();
                proposed_network = params.get("proposedNetworkPolicyAmendments").cloned();
                if let Some(ctx) = params.get("networkApprovalContext") {
                    args.insert("networkApprovalContext".into(), ctx.clone());
                }
                approval_kind_label = "command".into();
                (
                    "run_command".to_string(),
                    params
                        .get("reason")
                        .and_then(|r| r.as_str())
                        .unwrap_or("执行命令可能产生系统副作用")
                        .to_string(),
                    args,
                    ApprovalKind::CommandExecution,
                )
            }
            Some(ServerRequestMethod::ItemFileChangeRequestApproval) => {
                let mut args = Map::new();
                if let Some(item_id) = params.get("itemId") {
                    args.insert("itemId".into(), item_id.clone());
                }
                if let Some(changes) = params.get("changes") {
                    args.insert("changes".into(), changes.clone());
                }
                approval_kind_label = "fileChange".into();
                (
                    "write_file".to_string(),
                    params
                        .get("reason")
                        .and_then(|r| r.as_str())
                        .unwrap_or("写入文件可能修改本地磁盘内容")
                        .to_string(),
                    args,
                    ApprovalKind::FileChange,
                )
            }
            Some(ServerRequestMethod::ItemPermissionsRequestApproval) => {
                let mut args = Map::new();
                if let Some(cwd) = params.get("cwd") {
                    args.insert("cwd".into(), cwd.clone());
                }
                let perms = params.get("permissions").cloned().unwrap_or(Value::Null);
                args.insert("permissions".into(), perms.clone());
                requested_permissions = Some(perms);
                approval_kind_label = "permissions".into();
                (
                    "permissions".to_string(),
                    params
                        .get("reason")
                        .and_then(|r| r.as_str())
                        .unwrap_or("需要沙箱外路径或网络权限")
                        .to_string(),
                    args,
                    ApprovalKind::Permissions,
                )
            }
            Some(other) => {
                eprintln!("[codex] unimplemented server request: {}", other.as_str());
                let this = Arc::clone(self);
                let message = format!("client does not implement {}", other.as_str());
                tokio::spawn(async move {
                    if let Ok(client) = this.client().await {
                        let _ = client.respond_error(id, -32601, &message);
                    }
                });
                return;
            }
            None => {
                eprintln!("[codex] unknown server request: {method}");
                let this = Arc::clone(self);
                let message = format!("unknown server request method: {method}");
                tokio::spawn(async move {
                    if let Ok(client) = this.client().await {
                        let _ = client.respond_error(id, -32601, &message);
                    }
                });
                return;
            }
        };

        self.pending_approvals.lock().insert(
            request_id.clone(),
            PendingApproval {
                id,
                kind,
                requested_permissions: requested_permissions.clone(),
            },
        );

        let tool_call_id = params
            .get("itemId")
            .and_then(|v| v.as_str())
            .unwrap_or(&request_id)
            .to_string();

        let diff_summary = arguments.get("changes").and_then(|changes| {
            changes.as_array().map(|arr| {
                arr.iter()
                    .filter_map(|c| {
                        let path = c.get("path")?.as_str()?;
                        let diff = c.get("diff").and_then(|d| d.as_str()).unwrap_or("");
                        Some(format!("{path}\n{diff}"))
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n")
            })
        }).filter(|s| !s.is_empty());

        let req = ApprovalRequest {
            request_id: request_id.clone(),
            tool_call_id: tool_call_id.clone(),
            name: name.clone(),
            arguments: arguments
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            reason: reason.clone(),
            diff_summary: diff_summary.clone(),
            kind: Some(approval_kind_label.clone()),
            command_actions: command_actions.clone(),
            proposed_execpolicy_amendment: proposed_execpolicy.clone(),
            proposed_network_policy_amendments: proposed_network.clone(),
            permissions: requested_permissions.clone(),
        };

        self.emit_event(
            app,
            "item/toolCall/approval",
            json!({
                "requestId": request_id,
                "toolCallId": tool_call_id,
                "name": name,
                "arguments": arguments,
                "reason": reason,
                "diffSummary": diff_summary,
                "kind": approval_kind_label,
                "commandActions": command_actions,
                "proposedExecpolicyAmendment": proposed_execpolicy,
                "proposedNetworkPolicyAmendments": proposed_network,
                "permissions": requested_permissions,
            }),
        );
        let _ = app.emit("codex:approval", &req);
    }

    fn reply_dynamic_tool(self: &Arc<Self>, id: Value, result: DynamicToolCallResponse) {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            if let Ok(client) = this.client().await {
                let _ = client.respond_typed(id, &result);
            }
        });
    }

    fn handle_dynamic_tool_call(self: &Arc<Self>, app: &AppHandle, id: Value, params: Value) {
        let request_id = match &id {
            Value::Number(n) => n.to_string(),
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        let parsed: DynamicToolCallParams = match serde_json::from_value(params) {
            Ok(p) => p,
            Err(e) => {
                self.reply_dynamic_tool(
                    id,
                    DynamicTools::text_result(false, format!("参数无效：{e}")),
                );
                return;
            }
        };
        let tool = parsed.tool;
        let namespace = parsed.namespace.filter(|s| !s.is_empty());
        let arguments = parsed.arguments;
        let thread_id = parsed.thread_id;
        let turn_id = parsed.turn_id;
        let call_id = parsed.call_id;
        let scheduled = self.scheduled_job_id.lock().is_some();
        let project_id = self.active_project_id.lock().clone();

        let ctx = DispatchCtx {
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            call_id: call_id.clone(),
            project_id: project_id.clone(),
            scheduled,
            cron: self.cron(),
        };

        if scheduled {
            self.reply_dynamic_tool(
                id,
                DynamicTools::text_result(false, "定时执行轮次不能使用桌面工具"),
            );
            return;
        }

        if !DynamicTools::is_tool_enabled_for(
            Some(thread_id.as_str()),
            namespace.as_deref(),
            &tool,
        ) {
            self.reply_dynamic_tool(
                id,
                DynamicTools::text_result(false, "工具已在设置中关闭或不存在"),
            );
            return;
        }

        if DynamicTools::needs_confirm(namespace.as_deref(), &tool) {
            let summary =
                DynamicTools::preview_summary(namespace.as_deref(), &tool, &arguments, &ctx);
            self.pending_dynamic_tools.lock().insert(
                request_id.clone(),
                PendingDynamicTool {
                    id,
                    namespace: namespace.clone(),
                    tool: tool.clone(),
                    arguments: arguments.clone(),
                    thread_id,
                    turn_id,
                    call_id: call_id.clone(),
                    project_id,
                },
            );
            let req = DynamicToolConfirmRequest {
                request_id: request_id.clone(),
                call_id: call_id.clone(),
                namespace: namespace.clone(),
                tool: tool.clone(),
                summary: summary.clone(),
                arguments: arguments.clone(),
            };
            self.emit_event(
                app,
                "item/toolCall/dynamicConfirm",
                json!({
                    "requestId": request_id,
                    "callId": call_id,
                    "namespace": namespace,
                    "tool": tool,
                    "summary": summary,
                    "arguments": arguments,
                }),
            );
            let _ = app.emit("codex:dynamicTool", &req);
            return;
        }

        let result = self
            .dynamic_tools()
            .dispatch(namespace.as_deref(), &tool, &arguments, &ctx);
        self.reply_dynamic_tool(id, result);
    }

    pub async fn respond_dynamic_tool(self: &Arc<Self>, request_id: &str, allowed: bool) {
        let pending = self.pending_dynamic_tools.lock().remove(request_id);
        let Some(pending) = pending else { return };
        let Ok(client) = self.client().await else {
            return;
        };

        let result = if !allowed {
            DynamicTools::text_result(false, "用户未确认")
        } else {
            let ctx = DispatchCtx {
                thread_id: pending.thread_id,
                turn_id: pending.turn_id,
                call_id: pending.call_id,
                project_id: pending.project_id,
                scheduled: false,
                cron: self.cron(),
            };
            self.dynamic_tools().dispatch(
                pending.namespace.as_deref(),
                &pending.tool,
                &pending.arguments,
                &ctx,
            )
        };
        let _ = client.respond_typed(pending.id, &result);
    }

    pub async fn respond_mcp_elicitation(
        self: &Arc<Self>,
        request_id: &str,
        action: &str,
        content: Option<Value>,
    ) {
        let pending = self.pending_mcp_elicitations.lock().remove(request_id);
        let Some(pending) = pending else { return };
        let Ok(client) = self.client().await else {
            return;
        };
        let action = match action {
            "accept" => "accept",
            "cancel" => "cancel",
            _ => "decline",
        };
        let mut result = json!({ "action": action });
        if let Some(c) = content {
            if let Some(obj) = result.as_object_mut() {
                obj.insert("content".into(), c);
            }
        }
        let _ = client.respond(pending.id, result);
    }

    pub async fn respond_tool_user_input(
        self: &Arc<Self>,
        request_id: &str,
        answers: Value,
    ) {
        let pending = self.pending_tool_user_inputs.lock().remove(request_id);
        let Some(pending) = pending else { return };
        let Ok(client) = self.client().await else {
            return;
        };
        let _ = client.respond(pending.id, json!({ "answers": answers }));
    }

    pub async fn interrupt(self: &Arc<Self>) {
        // Fail any hanging dynamic-tool confirms so the server is not left waiting.
        let pending: Vec<(String, PendingDynamicTool)> =
            self.pending_dynamic_tools.lock().drain().collect();
        if !pending.is_empty() {
            if let Ok(client) = self.client().await {
                for (_rid, p) in pending {
                    let _ =
                        client.respond_typed(p.id, &DynamicTools::text_result(false, "用户中断"));
                }
            }
        }

        let tool_inputs: Vec<(String, PendingToolUserInput)> =
            self.pending_tool_user_inputs.lock().drain().collect();
        if !tool_inputs.is_empty() {
            if let Ok(client) = self.client().await {
                for (_rid, p) in tool_inputs {
                    let _ = client.respond(p.id, json!({ "answers": {} }));
                }
            }
        }

        let active = self.any_active_turn();
        let Some(active) = active else { return };
        let Ok(client) = self.client().await else {
            return;
        };
        let _ = client
            .turn_interrupt(&active.thread_id, &active.turn_id)
            .await;
    }

    /// Interrupt every in-flight turn (best-effort).
    pub async fn interrupt_all(self: &Arc<Self>) {
        let turns: Vec<ActiveTurn> = {
            let map = self.active_turns.lock();
            map.iter()
                .filter_map(|(tid, turn)| {
                    let t = turn.trim();
                    if t.is_empty() {
                        None
                    } else {
                        Some(ActiveTurn {
                            thread_id: tid.clone(),
                            turn_id: t.to_string(),
                        })
                    }
                })
                .collect()
        };
        if turns.is_empty() {
            return;
        }
        let Ok(client) = self.client().await else {
            return;
        };
        for active in turns {
            let _ = client
                .turn_interrupt(&active.thread_id, &active.turn_id)
                .await;
        }
    }

    pub async fn interrupt_thread(self: &Arc<Self>, thread_id: &str) {
        let Some(active) = self.active_turn_for(thread_id) else {
            return;
        };
        let Ok(client) = self.client().await else {
            return;
        };
        let _ = client
            .turn_interrupt(&active.thread_id, &active.turn_id)
            .await;
    }

    /// Interrupt current turn and drop both chat + cron pending lanes.
    pub async fn interrupt_and_clear_queues(self: &Arc<Self>) {
        self.interrupt_all().await;
        self.chat_queue.lock().clear();
        self.cron_queue.lock().clear();
        self.clear_all_turns();
        self.set_scheduled_job(None);
        self.emit_queue(&self.app);
    }

    pub async fn respond_approval(
        self: &Arc<Self>,
        request_id: &str,
        decision: &str,
        apply_network_amendment: Option<&Value>,
    ) {
        let pending = self.pending_approvals.lock().remove(request_id);
        let Some(pending) = pending else { return };
        let Ok(client) = self.client().await else {
            return;
        };

        let decision = decision.trim();
        let cancel_turn = decision == "cancel";

        match pending.kind {
            ApprovalKind::CommandExecution => {
                let result = if let Some(amend) = apply_network_amendment.filter(|v| !v.is_null()) {
                    // Prefer explicit network amendment when UI opts in.
                    json!({
                        "decision": {
                            "applyNetworkPolicyAmendment": {
                                "network_policy_amendment": amend
                            }
                        }
                    })
                } else {
                    let lit = match decision {
                        "acceptForSession" => "acceptForSession",
                        "cancel" => "cancel",
                        "decline" => "decline",
                        _ => "accept",
                    };
                    json!({ "decision": lit })
                };
                let _ = client.respond(pending.id, result);
            }
            ApprovalKind::FileChange => {
                let lit = match decision {
                    "acceptForSession" => "acceptForSession",
                    "cancel" => "cancel",
                    "decline" => "decline",
                    _ => "accept",
                };
                let result = FileChangeRequestApprovalResponse {
                    decision: FileChangeApprovalDecision::FileChangeApprovalDecisionLiteral(
                        match lit {
                            "acceptForSession" => FileChangeApprovalDecisionLiteral::AcceptForSession,
                            "cancel" => FileChangeApprovalDecisionLiteral::Cancel,
                            "decline" => FileChangeApprovalDecisionLiteral::Decline,
                            _ => FileChangeApprovalDecisionLiteral::Accept,
                        },
                    ),
                };
                let _ = client.respond_typed(pending.id, &result);
            }
            ApprovalKind::Permissions => {
                let scope = if decision == "acceptForSession" {
                    "session"
                } else {
                    "turn"
                };
                let permissions = if matches!(decision, "accept" | "acceptForSession") {
                    pending
                        .requested_permissions
                        .unwrap_or_else(|| json!({}))
                } else {
                    // Decline / cancel → grant nothing.
                    json!({})
                };
                let _ = client.respond(
                    pending.id,
                    json!({
                        "permissions": permissions,
                        "scope": scope,
                    }),
                );
            }
        }

        if cancel_turn {
            if let Some(active) = self.any_active_turn() {
                let _ = client
                    .turn_interrupt(&active.thread_id, &active.turn_id)
                    .await;
                self.release_thread(&active.thread_id);
            }
            self.set_scheduled_job(None);
            self.schedule_drain(self.app.clone());
        }
    }

    fn queue_snapshot(&self) -> QueueSnapshot {
        QueueSnapshot {
            chat: self.chat_queue.lock().iter().cloned().collect(),
            cron: self.cron_queue.lock().iter().cloned().collect(),
        }
    }

    pub fn enqueue_cron(&self, job_id: &str) -> bool {
        let mut q = self.cron_queue.lock();
        if q.iter().any(|p| p.job_id == job_id) {
            return false;
        }
        q.push_back(CronPending {
            id: job_id.to_string(),
            lane: "cron".into(),
            job_id: job_id.to_string(),
            created_at: now_iso(),
        });
        drop(q);
        self.emit_queue(&self.app);
        true
    }

    pub fn cancel_cron_pending(&self, job_id: &str) {
        let mut q = self.cron_queue.lock();
        let before = q.len();
        q.retain(|p| p.job_id != job_id);
        if q.len() != before {
            drop(q);
            self.emit_queue(&self.app);
        }
    }

    pub fn schedule_drain_pub(self: &Arc<Self>) {
        self.schedule_drain(self.app.clone());
    }

    pub fn set_scheduled_job(&self, id: Option<String>) {
        *self.scheduled_job_id.lock() = id;
    }

    pub fn is_scheduled_job(&self, job_id: &str) -> bool {
        self.scheduled_job_id.lock().as_deref() == Some(job_id)
    }

    pub fn force_idle_and_drain(self: &Arc<Self>) {
        self.clear_all_turns();
        self.set_scheduled_job(None);
        self.schedule_drain(self.app.clone());
    }

    pub fn emit_event_pub(&self, method: &str, params: Value) {
        self.emit_event(&self.app, method, params);
    }

    fn emit_queue(&self, app: &AppHandle) {
        self.persist_chat_queue();
        let _ = app.emit("codex:queue", self.queue_snapshot());
    }

    fn persist_chat_queue(&self) {
        let q: Vec<ChatPending> = self.chat_queue.lock().iter().cloned().collect();
        let path = crate::host::store::get_chat_pending_path();
        let _ = crate::host::store::write_json_file(&path, &q);
    }

    fn load_chat_queue(&self) {
        let path = crate::host::store::get_chat_pending_path();
        let loaded: Vec<ChatPending> =
            crate::host::store::read_json_file(&path, Vec::new());
        if loaded.is_empty() {
            return;
        }
        let mut q = self.chat_queue.lock();
        if q.is_empty() {
            *q = loaded.into();
        }
    }

    pub fn hydrate_queues(self: &Arc<Self>) {
        self.load_chat_queue();
        if !self.chat_queue.lock().is_empty() {
            self.emit_queue(&self.app);
        }
    }

    fn enqueue_chat(&self, app: &AppHandle, input: &StartTurnInput) -> ResultOrError {
        let mut q = self.chat_queue.lock();
        if q.len() >= CHAT_QUEUE_LIMIT {
            return ResultOrError::err("排队已满（最多 20 条）");
        }
        let id = input
            .pending_id
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        q.push_back(ChatPending {
            id: id.clone(),
            lane: "chat".into(),
            session_id: input.session_id.clone(),
            project_id: input.project_id.clone(),
            text: input.message.clone(),
            created_at: now_iso(),
            sending_soon: false,
            images: input.images.clone(),
            model: input.model.clone(),
            effort: input.effort.clone(),
            skills: input.skills.clone(),
            mentions: input.mentions.clone(),
        });
        drop(q);
        self.emit_queue(app);
        ResultOrError::queued(id)
    }

    fn schedule_drain(self: &Arc<Self>, app: AppHandle) {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            this.drain(app).await;
        });
    }

    async fn drain(self: Arc<Self>, app: AppHandle) {
        if self.draining.swap(true, Ordering::SeqCst) {
            return;
        }

        // Chat: start the first queued item whose session is idle (other
        // sessions may still be running in parallel).
        let next = {
            let mut q = self.chat_queue.lock();
            let turns = self.active_turns.lock();
            let pos = q
                .iter()
                .position(|p| !turns.contains_key(p.session_id.trim()));
            pos.and_then(|i| q.remove(i))
        };
        if let Some(item) = next {
            self.emit_queue(&app);
            let sid = item.session_id.clone();
            if !self.claim_thread(&sid) {
                // Session became busy — put back at front of same-session order.
                self.chat_queue.lock().push_front(item);
                self.emit_queue(&app);
                self.draining.store(false, Ordering::SeqCst);
                return;
            }
            self.draining.store(false, Ordering::SeqCst);
            let input = StartTurnInput {
                project_id: item.project_id,
                session_id: item.session_id,
                message: item.text,
                pending_id: None,
                images: item.images,
                model: item.model,
                effort: item.effort,
                skills: item.skills,
                mentions: item.mentions,
            };
            let result = self.run_turn(&app, input).await;
            if matches!(&result, ResultOrError { ok: false, .. }) {
                self.release_thread(&sid);
                self.schedule_drain(app);
            } else {
                // More idle-session items may be waiting.
                self.schedule_drain(app);
            }
            return;
        }

        // Cron still waits for global idle (one scheduled job at a time).
        if !self.active_turns.lock().is_empty() {
            self.draining.store(false, Ordering::SeqCst);
            return;
        }

        let cron_item = self.cron_queue.lock().pop_front();
        if let Some(item) = cron_item {
            self.emit_queue(&app);
            // Re-check under claim: a chat start may have raced in.
            if !self.active_turns.lock().is_empty() {
                self.cron_queue.lock().push_front(item);
                self.emit_queue(&app);
                self.draining.store(false, Ordering::SeqCst);
                return;
            }
            self.draining.store(false, Ordering::SeqCst);
            let job_id = item.job_id;
            self.cron().execute_job(job_id).await;
            return;
        }

        self.draining.store(false, Ordering::SeqCst);
    }

    pub fn cancel_pending(&self, id: &str) -> ResultOrError {
        let mut q = self.chat_queue.lock();
        let before = q.len();
        q.retain(|p| p.id != id);
        let removed = q.len() != before;
        drop(q);
        if removed {
            self.emit_queue(&self.app);
        }
        ResultOrError::ok()
    }

    pub async fn send_pending_now(self: Arc<Self>, id: String) -> ResultOrError {
        let session_id = {
            let mut q = self.chat_queue.lock();
            let Some(pos) = q.iter().position(|p| p.id == id) else {
                return ResultOrError::err("排队项不存在或已发送");
            };
            let mut item = q.remove(pos).expect("index checked");
            item.sending_soon = true;
            for p in q.iter_mut() {
                p.sending_soon = false;
            }
            let sid = item.session_id.clone();
            q.push_front(item);
            sid
        };
        self.emit_queue(&self.app);

        if self.thread_busy(&session_id) {
            self.interrupt_thread(&session_id).await;
            // Drain runs after turn/interrupted|completed|error.
        } else {
            let app = self.app.clone();
            self.drain(app).await;
        }
        ResultOrError::ok()
    }

    pub fn clear_session_pending(&self, session_id: &str) {
        let mut q = self.chat_queue.lock();
        let before = q.len();
        q.retain(|p| p.session_id != session_id);
        let changed = q.len() != before;
        drop(q);
        if changed {
            self.emit_queue(&self.app);
        }
    }

    pub async fn start_turn(self: Arc<Self>, input: StartTurnInput) -> ResultOrError {
        let app = self.app.clone();
        if input.message.trim().is_empty() && input.images.is_empty() {
            return ResultOrError::err("消息不能为空");
        }

        let session_id = input.session_id.trim().to_string();
        if session_id.is_empty() {
            return ResultOrError::err("缺少会话 id（threadId）");
        }

        // Same session busy → steer (or enqueue if no turn id / steer fails).
        // Other sessions may run in parallel — App Server only merges turn/start
        // on the *same* thread.
        if self.thread_busy(&session_id) {
            return self.steer_or_enqueue(&app, &input).await;
        }

        if !self.claim_thread(&session_id) {
            return self.steer_or_enqueue(&app, &input).await;
        }

        let result = self.run_turn(&app, input).await;
        if matches!(&result, ResultOrError { ok: false, .. }) {
            self.release_thread(&session_id);
            self.schedule_drain(app);
        }
        // Claim released on turn/completed for the success path.
        result
    }

    /// Mid-turn follow-up via `turn/steer`. Falls back to chat queue if no active turn id.
    async fn steer_or_enqueue(self: &Arc<Self>, app: &AppHandle, input: &StartTurnInput) -> ResultOrError {
        let session_id = input.session_id.trim();
        let Some(active) = self.active_turn_for(session_id) else {
            // Claimed but turn/started not yet — queue rather than double-start.
            return self.enqueue_chat(app, input);
        };

        let client = match self.client().await {
            Ok(c) => c,
            Err(e) => return ResultOrError::err(e),
        };
        let client_msg_id = input
            .pending_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        match client
            .turn_steer(
                &active.thread_id,
                &active.turn_id,
                input.message.trim(),
                &input.images,
                client_msg_id,
            )
            .await
        {
            Ok(_) => ResultOrError::ok(),
            Err(e) => {
                // expectedTurnId mismatch / race → queue as next turn.
                eprintln!("[codex-rpc] turn/steer failed, enqueue: {e}");
                self.enqueue_chat(app, input)
            }
        }
    }

    async fn run_turn(self: &Arc<Self>, app: &AppHandle, input: StartTurnInput) -> ResultOrError {
        if let Err(e) = self.ensure_connected().await {
            return ResultOrError::err(e);
        }

        let thread_id = input.session_id.trim().to_string();
        if thread_id.is_empty() {
            return ResultOrError::err("缺少会话 id（threadId）");
        }
        *self.active_project_id.lock() = Some(input.project_id.clone());

        let work_dir = self.projects.get(&input.project_id).map(|p| p.work_dir);

        let settings = self.settings.load();
        let model_owned = input
            .model
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| settings.as_ref().map(|s| s.default_model().to_string()));
        let model = model_owned.as_deref();

        let client = match self.client().await {
            Ok(c) => c,
            Err(e) => return ResultOrError::err(e),
        };

        let perms = Permissions::read_client(&client)
            .await
            .unwrap_or_else(|_| AgentPermissions::default_auto());

        if let Err(e) = client
            .thread_resume(
                &thread_id,
                &perms.sandbox,
                &perms.approval_policy,
                true,
                model,
            )
            .await
        {
            return ResultOrError::err(format!("无法恢复会话：{e}"));
        }

        let skills: Vec<(String, String)> = input
            .skills
            .iter()
            .map(|s| (s.name.clone(), s.path.clone()))
            .collect();
        let mentions: Vec<(String, String)> = input
            .mentions
            .iter()
            .map(|s| (s.name.clone(), s.path.clone()))
            .collect();

        let client_msg_id = input
            .pending_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if let Err(e) = client
            .turn_start(
                &thread_id,
                &input.message,
                &input.images,
                &skills,
                &mentions,
                model,
                &perms.sandbox,
                &perms.approval_policy,
                input.effort.as_deref(),
                client_msg_id,
            )
            .await
        {
            return ResultOrError::err(e);
        }

        self.emit_event(
            app,
            "session/start",
            json!({
                "projectId": input.project_id,
                "sessionId": thread_id,
                "threadId": thread_id,
                "workDir": work_dir,
            }),
        );

        ResultOrError::ok()
    }
}

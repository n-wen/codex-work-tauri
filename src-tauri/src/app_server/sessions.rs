use super::items::{item_to_tool_record, ToolCallRecord};
use super::permissions::{AgentPermissions, Permissions};
use super::RpcClient;
use crate::host::projects::Projects;
use crate::host::settings::Settings;
use crate::runtime::CodexRuntime;
use crate::types::now_iso;
use chrono::{TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallRecord>>,
    pub created_at: String,
    /// App Server turn id（`thread/fork` 的 `lastTurnId`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_steps: Option<Vec<PlanStepRecord>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_explanation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStepRecord {
    pub step: String,
    pub status: String,
}

/// App Server `ThreadStatus` (`thread/list` / `thread/status/changed`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ThreadStatus {
    NotLoaded,
    Idle,
    SystemError,
    Active {
        #[serde(default)]
        active_flags: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub project_id: String,
    pub title: String,
    /// Codex App Server thread id (JSON-RPC `thread/start` result).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    /// App Server thread cwd（无侧栏项目时仍是默认工作区 `Documents/Codex/日期/slug`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// API model id for this thread (from App Server thread.model).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub created_at: String,
    pub updated_at: String,
    /// Live / listed thread status from App Server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<ThreadStatus>,
}

pub struct Sessions {
    runtime: Arc<CodexRuntime>,
    projects: Arc<Projects>,
    settings: Arc<Settings>,
}

impl Sessions {
    pub fn new(
        runtime: Arc<CodexRuntime>,
        projects: Arc<Projects>,
        settings: Arc<Settings>,
    ) -> Self {
        Self {
            runtime,
            projects,
            settings,
        }
    }

    async fn client(&self) -> Result<Arc<RpcClient>, String> {
        self.runtime.client().await
    }

    async fn connect(&self) -> Result<Arc<RpcClient>, String> {
        self.runtime.connected_client().await
    }

    pub async fn list_all(&self) -> Result<Vec<Session>, String> {
        let client = self.connect().await?;
        self.list_all_with(&client).await
    }

    pub async fn list(&self, project_id: &str) -> Result<Vec<Session>, String> {
        let all = self.list_all().await?;
        Ok(all
            .into_iter()
            .filter(|s| s.project_id == project_id)
            .collect())
    }

    pub async fn get(&self, thread_id: &str) -> Result<Option<Session>, String> {
        let client = self.connect().await?;
        self.get_with(&client, thread_id).await
    }

    /// Caller already holds a live App Server connection (cron fire path).
    pub async fn create(
        &self,
        project_id: Option<&str>,
        title: Option<String>,
        inject_dynamic_tools: bool,
    ) -> Result<Session, String> {
        let client = self.client().await?;
        self.create_with(&client, project_id, title, inject_dynamic_tools)
            .await
    }

    pub async fn create_connected(
        &self,
        project_id: Option<&str>,
        title: Option<String>,
        inject_dynamic_tools: bool,
    ) -> Result<Session, String> {
        let _ = self.connect().await?;
        self.create(project_id, title, inject_dynamic_tools).await
    }

    pub async fn rename(&self, thread_id: &str, title: &str) -> Result<Session, String> {
        let client = self.connect().await?;
        let trimmed = title.trim();
        if trimmed.is_empty() {
            return Err("标题不能为空".into());
        }
        client.thread_name_set(thread_id, trimmed).await?;
        self.get_with(&client, thread_id)
            .await?
            .ok_or_else(|| "会话不存在".to_string())
    }

    /// Fork a thread into a new one. Optional `last_turn_id` keeps history through that turn.
    pub async fn fork(
        &self,
        thread_id: &str,
        last_turn_id: Option<&str>,
    ) -> Result<Session, String> {
        if thread_id.trim().is_empty() {
            return Err("会话 id 不能为空".into());
        }
        let client = self.connect().await?;
        let result = client
            .thread_fork(thread_id, last_turn_id)
            .await?;
        let thread = result.get("thread").cloned().unwrap_or(Value::Null);
        let new_id = thread
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if new_id.is_empty() {
            return Err("分叉失败（缺少新 threadId）".into());
        }

        // Prefer response turns when present; otherwise re-read with turns.
        let has_turns = thread
            .get("turns")
            .and_then(|v| v.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false);
        let session = if has_turns {
            self.session_from_thread(&thread, true)
        } else {
            self.get_with(&client, &new_id)
                .await?
                .unwrap_or_else(|| self.session_from_thread(&thread, false))
        };

        // Inject the same dynamicTools / developer instructions as start|resume
        // so the forked thread can call desktop tools immediately.
        let settings = self.settings.load();
        let model = settings.as_ref().map(|s| s.default_model());
        let perms = Permissions::read_client(&client)
            .await
            .unwrap_or_else(|_| AgentPermissions::default_auto());
        let _ = client
            .thread_resume(
                &new_id,
                &perms.sandbox,
                &perms.approval_policy,
                true,
                model,
            )
            .await;

        if let Some(pid) = Some(session.project_id.as_str()).filter(|s| !s.is_empty()) {
            self.projects.touch(pid);
        }
        Ok(session)
    }

    pub async fn archive(&self, thread_id: &str) -> Result<(), String> {
        if thread_id.trim().is_empty() {
            return Err("会话 id 不能为空".into());
        }
        let client = self.connect().await?;
        client.thread_archive(thread_id).await?;
        Ok(())
    }

    pub async fn unarchive(&self, thread_id: &str) -> Result<(), String> {
        if thread_id.trim().is_empty() {
            return Err("会话 id 不能为空".into());
        }
        let client = self.connect().await?;
        client.thread_unarchive(thread_id).await?;
        Ok(())
    }

    pub async fn delete(&self, thread_id: &str) -> Result<(), String> {
        if thread_id.trim().is_empty() {
            return Err("会话 id 不能为空".into());
        }
        let client = self.connect().await?;
        client.thread_delete(thread_id).await?;
        Ok(())
    }

    pub async fn list_archived(&self) -> Result<Vec<Session>, String> {
        let client = self.connect().await?;
        let threads = Self::fetch_all_threads(&client, true, None).await?;
        let mut sessions: Vec<Session> = threads
            .iter()
            .map(|t| self.session_from_thread(t, false))
            .filter(|s| !s.id.is_empty())
            .collect();
        sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(sessions)
    }

    /// Server-side title search via `thread/list.searchTerm`.
    pub async fn search(&self, search_term: &str) -> Result<Vec<Session>, String> {
        let term = search_term.trim();
        if term.is_empty() {
            return self.list_all().await;
        }
        let client = self.connect().await?;
        let threads = Self::fetch_all_threads(&client, false, Some(term)).await?;
        let mut sessions: Vec<Session> = threads
            .iter()
            .map(|t| self.session_from_thread(t, false))
            .filter(|s| !s.id.is_empty())
            .collect();
        sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(sessions)
    }

    async fn list_all_with(&self, client: &RpcClient) -> Result<Vec<Session>, String> {
        let threads = Self::fetch_all_threads(client, false, None).await?;
        let mut sessions: Vec<Session> = threads
            .iter()
            .map(|t| self.session_from_thread(t, false))
            .filter(|s| !s.id.is_empty())
            .collect();
        sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(sessions)
    }

    async fn get_with(&self, client: &RpcClient, thread_id: &str) -> Result<Option<Session>, String> {
        let result = client.thread_read(thread_id, false).await?;
        let thread = result.get("thread").cloned().unwrap_or(Value::Null);
        if thread
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .is_empty()
        {
            return Ok(None);
        }
        let mut session = self.session_from_thread(&thread, false);
        session.messages = Self::hydrate_messages(client, thread_id, &thread).await;
        Ok(Some(session))
    }

    /// Paginated history (`thread/turns/list` + optional `thread/items/list`).
    /// Falls back to legacy `thread/read includeTurns` if the store has no pagination.
    async fn hydrate_messages(
        client: &RpcClient,
        thread_id: &str,
        thread: &Value,
    ) -> Vec<ChatMessage> {
        match Self::fetch_turns_paginated(client, thread_id).await {
            Ok(turns) if !turns.is_empty() => {
                Self::messages_from_thread(&serde_json::json!({ "turns": turns }))
            }
            Ok(_) => {
                let existing = thread.get("turns").and_then(|v| v.as_array());
                if existing.map(|a| !a.is_empty()).unwrap_or(false) {
                    Self::messages_from_thread(thread)
                } else {
                    Vec::new()
                }
            }
            Err(err) => {
                eprintln!("[codex-rpc] thread/turns/list failed, legacy includeTurns: {err}");
                match client.thread_read(thread_id, true).await {
                    Ok(result) => {
                        let t = result.get("thread").unwrap_or(thread);
                        Self::messages_from_thread(t)
                    }
                    Err(_) => Self::messages_from_thread(thread),
                }
            }
        }
    }

    async fn fetch_turns_paginated(
        client: &RpcClient,
        thread_id: &str,
    ) -> Result<Vec<Value>, String> {
        let mut cursor: Option<String> = None;
        let mut turns = Vec::new();
        for _ in 0..50 {
            let page = client
                .thread_turns_list(thread_id, cursor.as_deref(), 50, "asc", "full")
                .await?;
            let data = page
                .get("data")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            for mut turn in data {
                let view = turn
                    .get("itemsView")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let has_items = turn
                    .get("items")
                    .and_then(|v| v.as_array())
                    .map(|a| !a.is_empty())
                    .unwrap_or(false);
                if view != "full" || !has_items {
                    let turn_id = turn
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    if !turn_id.is_empty() {
                        if let Ok(items) =
                            Self::fetch_items_for_turn(client, thread_id, &turn_id).await
                        {
                            turn["items"] = serde_json::json!(items);
                        }
                    }
                }
                turns.push(turn);
            }
            match page.get("nextCursor").and_then(|v| v.as_str()) {
                Some(c) if !c.is_empty() => cursor = Some(c.to_string()),
                _ => break,
            }
        }
        Ok(turns)
    }

    async fn fetch_items_for_turn(
        client: &RpcClient,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<Vec<Value>, String> {
        let mut cursor: Option<String> = None;
        let mut items = Vec::new();
        for _ in 0..50 {
            let page = client
                .thread_items_list(thread_id, Some(turn_id), cursor.as_deref(), 100, "asc")
                .await?;
            if let Some(data) = page.get("data").and_then(|v| v.as_array()) {
                for entry in data {
                    if let Some(item) = entry.get("item") {
                        items.push(item.clone());
                    } else {
                        items.push(entry.clone());
                    }
                }
            }
            match page.get("nextCursor").and_then(|v| v.as_str()) {
                Some(c) if !c.is_empty() => cursor = Some(c.to_string()),
                _ => break,
            }
        }
        Ok(items)
    }

    async fn create_with(
        &self,
        client: &RpcClient,
        project_id: Option<&str>,
        title: Option<String>,
        inject_dynamic_tools: bool,
    ) -> Result<Session, String> {
        let cwd = if let Some(pid) = project_id.filter(|id| !id.is_empty()) {
            let project = self
                .projects
                .get(pid)
                .ok_or_else(|| "项目不存在".to_string())?;
            project.work_dir
        } else {
            let (dir, _) = self.projects.default_workspace_dir()?;
            dir.to_string_lossy().to_string()
        };
        let settings = self.settings.load();
        let model = settings.as_ref().map(|s| s.default_model());
        let perms = Permissions::read_client(client)
            .await
            .unwrap_or_else(|_| AgentPermissions::default_auto());
        let result = client
            .thread_start(
                Some(cwd.as_str()),
                model,
                &perms.sandbox,
                &perms.approval_policy,
                inject_dynamic_tools,
            )
            .await?;
        let thread = result.get("thread").cloned().unwrap_or(Value::Null);
        let thread_id = thread
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if thread_id.is_empty() {
            return Err("无法创建会话（缺少 threadId）".into());
        }

        let trimmed_title = title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != "新会话" && *s != "新对话");
        if let Some(name) = trimmed_title {
            let _ = client.thread_name_set(&thread_id, name).await;
        }

        if let Some(pid) = project_id.filter(|id| !id.is_empty()) {
            self.projects.touch(pid);
        }

        let result = client
            .thread_read(&thread_id, false)
            .await
            .unwrap_or(result);
        let thread = result.get("thread").cloned().unwrap_or(thread);
        let mut session = self.session_from_thread(&thread, false);
        if let Some(pid) = project_id.filter(|id| !id.is_empty()) {
            session.project_id = pid.to_string();
        }
        Ok(session)
    }

    fn session_from_thread(&self, thread: &Value, include_messages: bool) -> Session {
        let id = thread
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let cwd = thread.get("cwd").and_then(|v| v.as_str()).unwrap_or("");
        let project_id = self
            .projects
            .find_listed_id_for_cwd(cwd)
            .unwrap_or_default();
        let name = thread
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let preview = thread
            .get("preview")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let title = name
            .or(preview)
            .unwrap_or("新对话")
            .chars()
            .take(80)
            .collect();

        let status = thread
            .get("status")
            .cloned()
            .and_then(|v| serde_json::from_value::<ThreadStatus>(v).ok());

        let model = thread
            .get("model")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        Session {
            id: id.clone(),
            project_id,
            title,
            thread_id: Some(id),
            cwd: if cwd.is_empty() {
                None
            } else {
                Some(cwd.to_string())
            },
            model,
            messages: if include_messages {
                Self::messages_from_thread(thread)
            } else {
                Vec::new()
            },
            created_at: Self::unix_field_to_iso(thread.get("createdAt")),
            updated_at: Self::unix_field_to_iso(thread.get("updatedAt")),
            status,
        }
    }

    async fn fetch_all_threads(
        client: &RpcClient,
        archived: bool,
        search_term: Option<&str>,
    ) -> Result<Vec<Value>, String> {
    let mut cursor: Option<String> = None;
    let mut out = Vec::new();
    for _ in 0..50 {
        let page = client
            .thread_list_page_ex(cursor.as_deref(), 100, archived, search_term)
            .await?;
        if let Some(arr) = page.get("data").and_then(|v| v.as_array()) {
            out.extend(arr.iter().cloned());
        }
        match page.get("nextCursor").and_then(|v| v.as_str()) {
            Some(c) if !c.is_empty() => cursor = Some(c.to_string()),
            _ => break,
        }
    }
    Ok(out)
    }

    fn messages_from_thread(thread: &Value) -> Vec<ChatMessage> {
    let mut messages = Vec::new();
    let turns = match thread.get("turns").and_then(|v| v.as_array()) {
        Some(t) => t,
        None => return messages,
    };

    for turn in turns {
        let turn_id = turn
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let created_at = Self::unix_field_to_iso(
            turn.get("startedAt")
                .or_else(|| turn.get("completedAt"))
                .or(None),
        );
        let items = turn.get("items").and_then(|v| v.as_array());
        let Some(items) = items else { continue };

        for item in items {
            let item_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let item_id = item
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            match item_type {
                "userMessage" => {
                    let content = Self::user_input_text(item.get("content"));
                    if content.is_empty() {
                        continue;
                    }
                    messages.push(ChatMessage {
                        id: item_id,
                        role: "user".into(),
                        content,
                        tool_calls: None,
                        created_at: created_at.clone(),
                        turn_id: turn_id.clone(),
                        kind: None,
                        reasoning_summary: None,
                        plan_steps: None,
                        plan_explanation: None,
                    });
                }
                "agentMessage" => {
                    let text = item.get("text").and_then(|t| t.as_str()).unwrap_or("");
                    messages.push(ChatMessage {
                        id: item_id,
                        role: "assistant".into(),
                        content: text.to_string(),
                        tool_calls: None,
                        created_at: created_at.clone(),
                        turn_id: turn_id.clone(),
                        kind: None,
                        reasoning_summary: None,
                        plan_steps: None,
                        plan_explanation: None,
                    });
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
                    if summary.is_empty() {
                        continue;
                    }
                    messages.push(ChatMessage {
                        id: item_id,
                        role: "assistant".into(),
                        content: String::new(),
                        tool_calls: None,
                        created_at: created_at.clone(),
                        turn_id: turn_id.clone(),
                        kind: Some("reasoning".into()),
                        reasoning_summary: Some(summary),
                        plan_steps: None,
                        plan_explanation: None,
                    });
                }
                "plan" => {
                    let text = item.get("text").and_then(|t| t.as_str()).unwrap_or("");
                    if text.is_empty() {
                        continue;
                    }
                    messages.push(ChatMessage {
                        id: item_id,
                        role: "assistant".into(),
                        content: String::new(),
                        tool_calls: None,
                        created_at: created_at.clone(),
                        turn_id: turn_id.clone(),
                        kind: Some("plan".into()),
                        reasoning_summary: None,
                        plan_steps: Some(vec![PlanStepRecord {
                            step: text.to_string(),
                            status: "completed".into(),
                        }]),
                        plan_explanation: None,
                    });
                }
                "commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall" => {
                    let tool = item_to_tool_record(item);
                    if let Some(last) = messages.last_mut() {
                        if last.role == "assistant" && last.kind.is_none() {
                            let mut tools = last.tool_calls.take().unwrap_or_default();
                            tools.push(tool);
                            last.tool_calls = Some(tools);
                            continue;
                        }
                    }
                    messages.push(ChatMessage {
                        id: format!("tools-{item_id}"),
                        role: "assistant".into(),
                        content: String::new(),
                        tool_calls: Some(vec![tool]),
                        created_at: created_at.clone(),
                        turn_id: turn_id.clone(),
                        kind: None,
                        reasoning_summary: None,
                        plan_steps: None,
                        plan_explanation: None,
                    });
                }
                _ => {}
            }
        }
    }
    messages
    }

    fn user_input_text(content: Option<&Value>) -> String {
    let Some(arr) = content.and_then(|v| v.as_array()) else {
        return String::new();
    };
    arr.iter()
        .filter_map(|u| match u.get("type").and_then(|t| t.as_str()) {
            Some("text") => u
                .get("text")
                .and_then(|t| t.as_str())
                .map(|s| s.to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
    }

    fn unix_field_to_iso(value: Option<&Value>) -> String {
    let secs = value.and_then(|v| v.as_i64()).or_else(|| {
        value
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<i64>().ok())
    });
    match secs {
        Some(s) => Utc
            .timestamp_opt(s, 0)
            .single()
            .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .unwrap_or_else(now_iso),
        None => now_iso(),
    }
    }
}

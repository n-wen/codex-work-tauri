//! IPC registry + composition root.
//!
//! `AppState` wires services once. `#[tauri::command]` functions live here and
//! forward to those services. Domain modules do not register IPC.

use crate::app_server::fs::{
    DirEntry, FileContent, FileMetadata, Fs, FuzzySearchResult, WatchHandle,
};
use crate::app_server::managed::{self, CodexRuntimeInfo};
use crate::app_server::permissions::{AgentPermissions, Permissions};
use crate::app_server::plugins::{PluginInfo, Plugins};
use crate::app_server::sessions::{Session, Sessions};
use crate::app_server::skills::{SkillInfo, Skills};
use crate::host::cron::{CronJob, CronService, UpsertCronJobInput};
use crate::host::dynamic_tools::{DynamicTools, DynamicToolsConfigPatch, DynamicToolsListResult};
use crate::host::preview::Preview;
use crate::host::projects::{CreateProjectInput, Project, Projects};
use crate::host::settings::{AppSettings, Settings};
use crate::runtime::{CodexRuntime, StartTurnInput};
use crate::types::{OkResult, ResultOrError};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

pub struct AppState {
    pub runtime: Arc<CodexRuntime>,
    pub cron: Arc<CronService>,
    pub projects: Arc<Projects>,
    pub settings: Arc<Settings>,
    pub sessions: Arc<Sessions>,
    pub permissions: Arc<Permissions>,
    pub skills: Arc<Skills>,
    pub plugins: Arc<Plugins>,
    pub fs: Arc<Fs>,
    pub dynamic_tools: Arc<DynamicTools>,
    pub preview: Arc<Preview>,
}

impl AppState {
    pub fn new(app: AppHandle) -> Self {
        let settings = Arc::new(Settings::new());
        let projects = Arc::new(Projects::new());
        let preview = Arc::new(Preview::new(app.clone()));
        let runtime = Arc::new(CodexRuntime::new(
            app,
            Arc::clone(&settings),
            Arc::clone(&projects),
        ));
        let sessions = Arc::new(Sessions::new(
            Arc::clone(&runtime),
            Arc::clone(&projects),
            Arc::clone(&settings),
        ));
        let permissions = Arc::new(Permissions::new(Arc::clone(&runtime)));
        let skills = Arc::new(Skills::new(Arc::clone(&runtime)));
        let plugins = Arc::new(Plugins::new(Arc::clone(&runtime)));
        let fs = Arc::new(Fs::new(Arc::clone(&runtime)));
        let dynamic_tools = Arc::new(DynamicTools::new(Arc::clone(&preview)));
        runtime.attach_dynamic_tools(Arc::clone(&dynamic_tools));
        let cron = Arc::new(CronService::new(
            Arc::clone(&runtime),
            Arc::clone(&sessions),
            Arc::clone(&projects),
            Arc::clone(&settings),
        ));
        runtime.attach_cron(Arc::clone(&cron));
        runtime.hydrate_queues();
        Self {
            runtime,
            cron,
            projects,
            settings,
            sessions,
            permissions,
            skills,
            plugins,
            fs,
            dynamic_tools,
            preview,
        }
    }
}

pub fn invoke_handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        get_settings,
        save_settings_cmd,
        validate_settings_cmd,
        mask_api_key_cmd,
        get_codex_runtime,
        list_projects_cmd,
        create_project_cmd,
        create_default_project_cmd,
        rename_project_cmd,
        delete_project_cmd,
        select_directory,
        list_sessions_cmd,
        list_all_sessions_cmd,
        create_session_cmd,
        get_session_cmd,
        rename_session_cmd,
        fork_session_cmd,
        search_sessions_cmd,
        archive_session_cmd,
        unarchive_session_cmd,
        delete_session_cmd,
        list_archived_sessions_cmd,
        start_turn,
        interrupt_turn,
        interrupt_and_clear_queues_cmd,
        cancel_pending_cmd,
        send_pending_now_cmd,
        respond_approval,
        respond_mcp_elicitation,
        ensure_app_server,
        get_agent_permissions,
        set_agent_permissions,
        get_provider_capabilities,
        read_app_config_cmd,
        write_app_config_value_cmd,
        list_experimental_features_cmd,
        set_experimental_feature_cmd,
        read_config_requirements_cmd,
        list_mcp_servers_cmd,
        upsert_mcp_server_cmd,
        delete_mcp_server_cmd,
        reload_mcp_servers_cmd,
        mcp_server_oauth_login_cmd,
        mcp_server_resource_read_cmd,
        mcp_server_tool_call_cmd,
        list_permission_profiles_cmd,
        set_default_permission_profile_cmd,
        list_skills_cmd,
        set_skill_enabled_cmd,
        list_plugins_cmd,
        install_plugin_cmd,
        uninstall_plugin_cmd,
        fs_read_directory_cmd,
        fs_read_file_cmd,
        fs_write_file_cmd,
        fs_write_text_file_cmd,
        fs_create_directory_cmd,
        fs_get_metadata_cmd,
        fs_remove_cmd,
        fs_copy_cmd,
        fs_watch_cmd,
        fs_unwatch_cmd,
        fuzzy_file_search_cmd,
        get_git_status_cmd,
        get_git_diff_cmd,
        git_stage_cmd,
        git_commit_cmd,
        open_in_editor_cmd,
        list_cron_jobs_cmd,
        upsert_cron_job_cmd,
        delete_cron_job_cmd,
        set_cron_job_enabled_cmd,
        run_cron_job_now_cmd,
        list_dynamic_tools_cmd,
        set_dynamic_tools_config_cmd,
        list_session_dynamic_tools_cmd,
        set_session_dynamic_tools_cmd,
        clear_session_dynamic_tools_cmd,
        respond_dynamic_tool_cmd,
        respond_tool_user_input_cmd,
        compact_thread_cmd,
        review_start_cmd,
        thread_goal_get_cmd,
        thread_goal_set_cmd,
        thread_goal_clear_cmd,
        command_exec_cmd,
        command_exec_write_cmd,
        command_exec_resize_cmd,
        command_exec_terminate_cmd,
        plugin_read_cmd,
        add_plugin_scheduled_task_cmd,
        get_autostart_enabled_cmd,
        set_autostart_enabled_cmd,
        set_preview_focus_session,
        open_preview_window,
        close_preview_window,
        preview_content_navigate,
        preview_content_back,
        preview_content_forward,
        preview_content_reload,
    ]
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Option<AppSettings> {
    state.settings.load()
}

#[tauri::command]
async fn save_settings_cmd(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<ResultOrError, String> {
    let svc = state.settings.clone();
    let validated = svc.validate(&settings).await;
    if !validated.ok {
        return Ok(validated);
    }
    let prev_fp = svc
        .load()
        .map(|s| s.connection_fingerprint())
        .unwrap_or_default();
    match svc.save(&settings) {
        Ok(()) => {
            let next_fp = settings.connection_fingerprint();
            let server_live = state.runtime.client().await.is_ok();
            if server_live && prev_fp != next_fp {
                if let Err(e) = state.runtime.reconnect().await {
                    return Ok(ResultOrError::err(format!(
                        "设置已保存，但重启 App Server 失败：{e}"
                    )));
                }
            }
            Ok(ResultOrError::ok())
        }
        Err(e) => Ok(ResultOrError::err(e)),
    }
}

#[tauri::command]
async fn validate_settings_cmd(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<ResultOrError, String> {
    Ok(state.settings.clone().validate(&settings).await)
}

#[tauri::command]
fn mask_api_key_cmd(state: State<'_, AppState>, api_key: String) -> String {
    state.settings.mask_api_key(&api_key)
}

#[tauri::command]
fn get_codex_runtime(state: State<'_, AppState>) -> CodexRuntimeInfo {
    let override_path = state.settings.load().and_then(|s| s.codex_bin);
    managed::CodexBin::runtime_info(override_path.as_deref())
}

#[tauri::command]
fn list_projects_cmd(state: State<'_, AppState>) -> Vec<Project> {
    state.projects.list()
}

#[tauri::command]
fn create_project_cmd(
    state: State<'_, AppState>,
    input: CreateProjectInput,
) -> Result<Project, String> {
    state.projects.create(input)
}

#[tauri::command]
fn create_default_project_cmd(state: State<'_, AppState>) -> Result<Project, String> {
    state.projects.create_default()
}

#[tauri::command]
fn rename_project_cmd(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<Project, String> {
    state.projects.rename(&id, &name)
}

#[tauri::command]
fn delete_project_cmd(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.projects.delete(&id)
}

#[tauri::command]
async fn select_directory(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state
        .runtime
        .app()
        .dialog()
        .file()
        .set_title("选择项目工作目录")
        .pick_folder(move |folder| {
            let path = folder
                .and_then(|p| p.into_path().ok())
                .map(|p| p.to_string_lossy().to_string());
            let _ = tx.send(path);
        });
    Ok(rx.await.ok().flatten())
}

#[tauri::command]
async fn list_sessions_cmd(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<Session>, String> {
    state.sessions.list(&project_id).await
}

#[tauri::command]
async fn list_all_sessions_cmd(state: State<'_, AppState>) -> Result<Vec<Session>, String> {
    state.sessions.list_all().await
}

#[tauri::command]
async fn create_session_cmd(
    state: State<'_, AppState>,
    project_id: Option<String>,
    title: Option<String>,
) -> Result<Session, String> {
    state
        .sessions
        .create_connected(project_id.as_deref(), title, true)
        .await
}

#[tauri::command]
async fn get_session_cmd(
    state: State<'_, AppState>,
    project_id: String,
    session_id: String,
) -> Result<Option<Session>, String> {
    let _ = project_id;
    state.sessions.get(&session_id).await
}

#[tauri::command]
async fn rename_session_cmd(
    state: State<'_, AppState>,
    project_id: String,
    session_id: String,
    title: String,
) -> Result<Session, String> {
    let _ = project_id;
    state.sessions.rename(&session_id, &title).await
}

#[tauri::command]
async fn fork_session_cmd(
    state: State<'_, AppState>,
    session_id: String,
    last_turn_id: Option<String>,
) -> Result<Session, String> {
    state
        .sessions
        .fork(&session_id, last_turn_id.as_deref())
        .await
}

#[tauri::command]
async fn search_sessions_cmd(
    state: State<'_, AppState>,
    search_term: String,
) -> Result<Vec<Session>, String> {
    state.sessions.search(&search_term).await
}

#[tauri::command]
async fn archive_session_cmd(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state.sessions.archive(&session_id).await
}

#[tauri::command]
async fn unarchive_session_cmd(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state.sessions.unarchive(&session_id).await
}

#[tauri::command]
async fn delete_session_cmd(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state.sessions.delete(&session_id).await?;
    state.runtime.clear_session_pending(&session_id);
    Ok(())
}

#[tauri::command]
async fn list_archived_sessions_cmd(state: State<'_, AppState>) -> Result<Vec<Session>, String> {
    state.sessions.list_archived().await
}

#[tauri::command]
async fn ensure_app_server(state: State<'_, AppState>) -> Result<ResultOrError, String> {
    match state.runtime.ensure_connected().await {
        Ok(()) => Ok(ResultOrError::ok()),
        Err(e) => Ok(ResultOrError::err(e)),
    }
}

#[tauri::command]
async fn start_turn(
    state: State<'_, AppState>,
    input: StartTurnInput,
) -> Result<ResultOrError, String> {
    let state: &AppState = &state;
    Ok(state.runtime.clone().start_turn(input).await)
}

#[tauri::command]
async fn interrupt_turn(
    state: State<'_, AppState>,
    session_id: Option<String>,
) -> Result<OkResult, String> {
    let sid = session_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(sid) = sid {
        state.runtime.clone().interrupt_thread(sid).await;
    } else {
        state.runtime.clone().interrupt().await;
    }
    Ok(OkResult { ok: true })
}

#[tauri::command]
async fn interrupt_and_clear_queues_cmd(state: State<'_, AppState>) -> Result<OkResult, String> {
    state.runtime.clone().interrupt_and_clear_queues().await;
    Ok(OkResult { ok: true })
}

#[tauri::command]
fn cancel_pending_cmd(state: State<'_, AppState>, id: String) -> Result<ResultOrError, String> {
    Ok(state.runtime.cancel_pending(&id))
}

#[tauri::command]
async fn send_pending_now_cmd(
    state: State<'_, AppState>,
    id: String,
) -> Result<ResultOrError, String> {
    Ok(state.runtime.clone().send_pending_now(id).await)
}

#[tauri::command]
async fn respond_approval(
    state: State<'_, AppState>,
    request_id: String,
    decision: String,
    apply_network_amendment: Option<serde_json::Value>,
) -> Result<OkResult, String> {
    state
        .runtime
        .clone()
        .respond_approval(&request_id, &decision, apply_network_amendment.as_ref())
        .await;
    Ok(OkResult { ok: true })
}

#[tauri::command]
async fn respond_mcp_elicitation(
    state: State<'_, AppState>,
    request_id: String,
    action: String,
    content: Option<serde_json::Value>,
) -> Result<OkResult, String> {
    state
        .runtime
        .clone()
        .respond_mcp_elicitation(&request_id, &action, content)
        .await;
    Ok(OkResult { ok: true })
}

#[tauri::command]
async fn get_agent_permissions(state: State<'_, AppState>) -> Result<AgentPermissions, String> {
    state.permissions.read().await
}

#[tauri::command]
async fn set_agent_permissions(
    state: State<'_, AppState>,
    permissions: AgentPermissions,
) -> Result<AgentPermissions, String> {
    state.permissions.write(permissions).await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReasoningEffortOptionDto {
    effort: String,
    description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderCapabilitiesDto {
    namespace_tools: bool,
    image_generation: bool,
    web_search: bool,
    /// Whether the selected (or default) model accepts image input.
    input_images: bool,
    reasoning_efforts: Vec<ReasoningEffortOptionDto>,
    default_reasoning_effort: Option<String>,
}

#[tauri::command]
async fn get_provider_capabilities(
    state: State<'_, AppState>,
    model: Option<String>,
) -> Result<ProviderCapabilitiesDto, String> {
    let client = state.runtime.connected_client().await?;
    let caps = client
        .model_provider_capabilities_read()
        .await
        .unwrap_or_else(|_| serde_json::json!({}));
    let namespace_tools = caps
        .get("namespaceTools")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let image_generation = caps
        .get("imageGeneration")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let web_search = caps
        .get("webSearch")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let wanted = model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            state
                .settings
                .load()
                .map(|s| s.default_model().to_string())
                .filter(|s| !s.is_empty())
        });

    let mut input_images = true;
    let mut reasoning_efforts = Vec::new();
    let mut default_reasoning_effort = None;

    if let Ok(list) = client.model_list(true).await {
        if let Some(data) = list.get("data").and_then(|v| v.as_array()) {
            let entry = wanted
                .as_ref()
                .and_then(|id| {
                    data.iter().find(|m| {
                        m.get("model").and_then(|v| v.as_str()) == Some(id.as_str())
                            || m.get("id").and_then(|v| v.as_str()) == Some(id.as_str())
                    })
                })
                .or_else(|| data.iter().find(|m| m.get("isDefault").and_then(|v| v.as_bool()) == Some(true)))
                .or_else(|| data.first());

            if let Some(m) = entry {
                if let Some(mods) = m.get("inputModalities").and_then(|v| v.as_array()) {
                    input_images = mods.iter().any(|x| {
                        matches!(x.as_str(), Some("image") | Some("Image") | Some("localImage"))
                    });
                }
                if let Some(efforts) = m
                    .get("supportedReasoningEfforts")
                    .and_then(|v| v.as_array())
                {
                    for e in efforts {
                        let effort = e
                            .get("reasoningEffort")
                            .or_else(|| e.get("effort"))
                            .and_then(|v| v.as_str())
                            .or_else(|| e.as_str())
                            .unwrap_or("")
                            .to_string();
                        if effort.is_empty() {
                            continue;
                        }
                        let description = e
                            .get("description")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        reasoning_efforts.push(ReasoningEffortOptionDto {
                            effort,
                            description,
                        });
                    }
                }
                default_reasoning_effort = m
                    .get("defaultReasoningEffort")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
            }
        }
    }

    Ok(ProviderCapabilitiesDto {
        namespace_tools,
        image_generation,
        web_search,
        input_images,
        reasoning_efforts,
        default_reasoning_effort,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppConfigSnapshot {
    model: Option<String>,
    model_reasoning_effort: Option<String>,
    /// Raw merged config object for advanced display.
    config: serde_json::Value,
}

#[tauri::command]
async fn read_app_config_cmd(state: State<'_, AppState>) -> Result<AppConfigSnapshot, String> {
    let client = state.runtime.connected_client().await?;
    let result = client.config_read().await?;
    let config = result.get("config").cloned().unwrap_or(serde_json::Value::Null);
    let model = config
        .get("model")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let model_reasoning_effort = config
        .get("model_reasoning_effort")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    Ok(AppConfigSnapshot {
        model,
        model_reasoning_effort,
        config,
    })
}

#[tauri::command]
async fn write_app_config_value_cmd(
    state: State<'_, AppState>,
    key_path: String,
    value: serde_json::Value,
) -> Result<AppConfigSnapshot, String> {
    let key = key_path.trim();
    const ALLOWED: &[&str] = &[
        "model_reasoning_effort",
        "model",
        "personality",
        "web_search",
    ];
    let allowed = ALLOWED.contains(&key)
        || key == "mcp_servers"
        || key.starts_with("mcp_servers.");
    if !allowed {
        return Err(format!("不允许写入 keyPath：{key}"));
    }
    let client = state.runtime.connected_client().await?;
    let upsert = key.starts_with("mcp_servers.");
    client.config_value_write_ex(key, value, upsert).await?;
    let result = client.config_read().await?;
    let config = result.get("config").cloned().unwrap_or(serde_json::Value::Null);
    Ok(AppConfigSnapshot {
        model: config
            .get("model")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        model_reasoning_effort: config
            .get("model_reasoning_effort")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        config,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExperimentalFeatureDto {
    name: String,
    stage: Option<String>,
    display_name: Option<String>,
    description: Option<String>,
    enabled: bool,
    default_enabled: Option<bool>,
}

#[tauri::command]
async fn list_experimental_features_cmd(
    state: State<'_, AppState>,
) -> Result<Vec<ExperimentalFeatureDto>, String> {
    let client = state.runtime.connected_client().await?;
    let result = client.experimental_feature_list().await?;
    let data = result
        .get("data")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(data
        .into_iter()
        .filter_map(|v| {
            let name = v.get("name")?.as_str()?.to_string();
            Some(ExperimentalFeatureDto {
                name,
                stage: v.get("stage").and_then(|x| x.as_str()).map(str::to_string),
                display_name: v
                    .get("displayName")
                    .and_then(|x| x.as_str())
                    .map(str::to_string),
                description: v
                    .get("description")
                    .and_then(|x| x.as_str())
                    .map(str::to_string),
                enabled: v.get("enabled").and_then(|x| x.as_bool()).unwrap_or(false),
                default_enabled: v.get("defaultEnabled").and_then(|x| x.as_bool()),
            })
        })
        .collect())
}

#[tauri::command]
async fn set_experimental_feature_cmd(
    state: State<'_, AppState>,
    name: String,
    enabled: bool,
) -> Result<Vec<ExperimentalFeatureDto>, String> {
    let client = state.runtime.connected_client().await?;
    let mut map = serde_json::Map::new();
    map.insert(name, serde_json::Value::Bool(enabled));
    client
        .experimental_feature_enablement_set(serde_json::Value::Object(map))
        .await?;
    let result = client.experimental_feature_list().await?;
    let data = result
        .get("data")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(data
        .into_iter()
        .filter_map(|v| {
            let name = v.get("name")?.as_str()?.to_string();
            Some(ExperimentalFeatureDto {
                name,
                stage: v.get("stage").and_then(|x| x.as_str()).map(str::to_string),
                display_name: v
                    .get("displayName")
                    .and_then(|x| x.as_str())
                    .map(str::to_string),
                description: v
                    .get("description")
                    .and_then(|x| x.as_str())
                    .map(str::to_string),
                enabled: v.get("enabled").and_then(|x| x.as_bool()).unwrap_or(false),
                default_enabled: v.get("defaultEnabled").and_then(|x| x.as_bool()),
            })
        })
        .collect())
}

#[tauri::command]
async fn read_config_requirements_cmd(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let client = state.runtime.connected_client().await?;
    client.config_requirements_read().await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpServerToolDto {
    name: String,
    description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpServerRowDto {
    name: String,
    enabled: bool,
    transport: String,
    command: Option<String>,
    args: Vec<String>,
    cwd: Option<String>,
    url: Option<String>,
    env_text: String,
    auth_status: Option<String>,
    startup_status: Option<String>,
    error: Option<String>,
    tools: Vec<McpServerToolDto>,
}

fn env_map_to_text(env: Option<&serde_json::Map<String, serde_json::Value>>) -> String {
    let Some(env) = env else { return String::new() };
    let mut lines: Vec<String> = env
        .iter()
        .map(|(k, v)| {
            let val = v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string());
            format!("{k}={val}")
        })
        .collect();
    lines.sort();
    lines.join("\n")
}

fn parse_env_text(text: &str) -> serde_json::Map<String, serde_json::Value> {
    let mut map = serde_json::Map::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let key = k.trim();
            if !key.is_empty() {
                map.insert(key.to_string(), serde_json::Value::String(v.to_string()));
            }
        }
    }
    map
}

#[tauri::command]
async fn list_mcp_servers_cmd(state: State<'_, AppState>) -> Result<Vec<McpServerRowDto>, String> {
    let client = state.runtime.connected_client().await?;
    let cfg = client.config_read().await?;
    let config = cfg.get("config").cloned().unwrap_or(serde_json::Value::Null);
    let servers = config
        .get("mcp_servers")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let status = client.mcp_server_status_list().await.unwrap_or(serde_json::json!({}));
    let status_rows = status
        .get("data")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut status_by_name = std::collections::HashMap::new();
    for row in status_rows {
        if let Some(name) = row.get("name").and_then(|v| v.as_str()) {
            status_by_name.insert(name.to_string(), row);
        }
    }

    let mut out = Vec::new();
    for (name, entry) in servers {
        let obj = entry.as_object();
        let command = obj
            .and_then(|o| o.get("command"))
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let url = obj
            .and_then(|o| o.get("url"))
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let args = obj
            .and_then(|o| o.get("args"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let cwd = obj
            .and_then(|o| o.get("cwd"))
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let enabled = obj
            .and_then(|o| o.get("enabled"))
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let env_text = env_map_to_text(obj.and_then(|o| o.get("env")).and_then(|v| v.as_object()));
        let transport = if url.as_ref().is_some_and(|u| !u.is_empty()) {
            "http".into()
        } else {
            "stdio".into()
        };

        let st = status_by_name.get(&name);
        let auth_status = st
            .and_then(|v| v.get("authStatus"))
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let tools = st
            .and_then(|v| v.get("tools"))
            .and_then(|v| v.as_object())
            .map(|tools| {
                tools
                    .iter()
                    .map(|(tool_name, t)| McpServerToolDto {
                        name: tool_name.clone(),
                        description: t
                            .get("description")
                            .and_then(|x| x.as_str())
                            .map(str::to_string),
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        out.push(McpServerRowDto {
            name,
            enabled,
            transport,
            command,
            args,
            cwd,
            url,
            env_text,
            auth_status,
            startup_status: None,
            error: None,
            tools,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertMcpServerInput {
    name: String,
    enabled: bool,
    transport: String,
    command: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    url: Option<String>,
    env_text: Option<String>,
}

#[tauri::command]
async fn upsert_mcp_server_cmd(
    state: State<'_, AppState>,
    input: UpsertMcpServerInput,
) -> Result<Vec<McpServerRowDto>, String> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("请填写 MCP 服务器名称".into());
    }
    if name
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.'))
    {
        return Err("名称仅允许字母数字、_ - .".into());
    }
    let mut obj = serde_json::Map::new();
    obj.insert("enabled".into(), serde_json::Value::Bool(input.enabled));
    if input.transport == "http" {
        let url = input.url.unwrap_or_default();
        let url = url.trim();
        if url.is_empty() {
            return Err("HTTP 传输需要填写 url".into());
        }
        obj.insert("url".into(), serde_json::Value::String(url.into()));
    } else {
        let command = input.command.unwrap_or_default();
        let command = command.trim();
        if command.is_empty() {
            return Err("stdio 传输需要填写 command".into());
        }
        obj.insert("command".into(), serde_json::Value::String(command.into()));
        let args = input.args.unwrap_or_default();
        obj.insert(
            "args".into(),
            serde_json::Value::Array(
                args.into_iter()
                    .map(serde_json::Value::String)
                    .collect(),
            ),
        );
        if let Some(cwd) = input.cwd.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
            obj.insert("cwd".into(), serde_json::Value::String(cwd));
        }
    }
    let env = parse_env_text(input.env_text.as_deref().unwrap_or(""));
    if !env.is_empty() {
        obj.insert("env".into(), serde_json::Value::Object(env));
    }

    let client = state.runtime.connected_client().await?;
    client
        .config_value_write_ex(
            &format!("mcp_servers.{name}"),
            serde_json::Value::Object(obj),
            true,
        )
        .await?;
    let _ = client.config_mcp_server_reload().await;
    drop(client);
    list_mcp_servers_cmd(state).await
}

#[tauri::command]
async fn delete_mcp_server_cmd(
    state: State<'_, AppState>,
    name: String,
) -> Result<Vec<McpServerRowDto>, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("缺少名称".into());
    }
    let client = state.runtime.connected_client().await?;
    let cfg = client.config_read().await?;
    let mut servers = cfg
        .pointer("/config/mcp_servers")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    servers.remove(name);
    client
        .config_value_write_ex(
            "mcp_servers",
            serde_json::Value::Object(servers),
            false,
        )
        .await?;
    let _ = client.config_mcp_server_reload().await;
    list_mcp_servers_cmd(state).await
}

#[tauri::command]
async fn reload_mcp_servers_cmd(state: State<'_, AppState>) -> Result<Vec<McpServerRowDto>, String> {
    let client = state.runtime.connected_client().await?;
    let _ = client.config_mcp_server_reload().await;
    list_mcp_servers_cmd(state).await
}

#[tauri::command]
async fn mcp_server_oauth_login_cmd(
    state: State<'_, AppState>,
    name: String,
) -> Result<String, String> {
    let client = state.runtime.connected_client().await?;
    let result = client.mcp_server_oauth_login(name.trim()).await?;
    result
        .get("authorizationUrl")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| "OAuth 响应缺少 authorizationUrl".into())
}

#[tauri::command]
async fn mcp_server_resource_read_cmd(
    state: State<'_, AppState>,
    server: String,
    uri: String,
    thread_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let client = state.runtime.connected_client().await?;
    client
        .mcp_server_resource_read(
            server.trim(),
            uri.trim(),
            thread_id.as_deref(),
        )
        .await
}

#[tauri::command]
async fn mcp_server_tool_call_cmd(
    state: State<'_, AppState>,
    server: String,
    tool: String,
    thread_id: String,
    arguments: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let thread_id = thread_id.trim();
    if thread_id.is_empty() {
        return Err("手动调用 MCP 工具需要当前会话 threadId".into());
    }
    let client = state.runtime.ensure_thread_resumed(thread_id).await?;
    client
        .mcp_server_tool_call(server.trim(), tool.trim(), thread_id, arguments)
        .await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PermissionProfileDto {
    id: String,
    allowed: bool,
    description: Option<String>,
}

#[tauri::command]
async fn list_permission_profiles_cmd(
    state: State<'_, AppState>,
    cwd: Option<String>,
) -> Result<Vec<PermissionProfileDto>, String> {
    let client = state.runtime.connected_client().await?;
    let result = client
        .permission_profile_list(cwd.as_deref())
        .await?;
    let mut out = Vec::new();
    if let Some(arr) = result.get("data").and_then(|v| v.as_array()) {
        for row in arr {
            let id = row
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if id.is_empty() {
                continue;
            }
            out.push(PermissionProfileDto {
                id,
                allowed: row
                    .get("allowed")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true),
                description: row
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
            });
        }
    }
    Ok(out)
}

#[tauri::command]
async fn set_default_permission_profile_cmd(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<(), String> {
    let profile_id = profile_id.trim();
    if profile_id.is_empty() {
        return Err("profile id 为空".into());
    }
    let client = state.runtime.connected_client().await?;
    client
        .config_value_write("default_permissions", serde_json::json!(profile_id))
        .await?;
    Ok(())
}

#[tauri::command]
async fn list_skills_cmd(
    state: State<'_, AppState>,
    cwds: Option<Vec<String>>,
    force_reload: Option<bool>,
) -> Result<Vec<SkillInfo>, String> {
    state
        .skills
        .list(cwds, force_reload.unwrap_or(false))
        .await
}

#[tauri::command]
async fn set_skill_enabled_cmd(
    state: State<'_, AppState>,
    enabled: bool,
    name: Option<String>,
    path: Option<String>,
) -> Result<bool, String> {
    state
        .skills
        .set_enabled(enabled, name, path)
        .await
}

#[tauri::command]
async fn list_plugins_cmd(
    state: State<'_, AppState>,
    cwds: Option<Vec<String>>,
) -> Result<Vec<PluginInfo>, String> {
    state.plugins.list(cwds).await
}

#[tauri::command]
async fn install_plugin_cmd(
    state: State<'_, AppState>,
    plugin_name: String,
    marketplace_path: Option<String>,
    remote_marketplace_name: Option<String>,
) -> Result<(), String> {
    state
        .plugins
        .install(plugin_name, marketplace_path, remote_marketplace_name)
        .await
}

#[tauri::command]
async fn uninstall_plugin_cmd(
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<(), String> {
    state.plugins.uninstall(plugin_id).await
}

#[tauri::command]
async fn fs_read_directory_cmd(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<DirEntry>, String> {
    state.fs.read_directory(&path).await
}

#[tauri::command]
async fn fs_read_file_cmd(state: State<'_, AppState>, path: String) -> Result<FileContent, String> {
    state.fs.read_file(&path).await
}

#[tauri::command]
async fn fs_write_file_cmd(
    state: State<'_, AppState>,
    path: String,
    data_base64: String,
) -> Result<(), String> {
    state.fs.write_file(&path, &data_base64).await
}

#[tauri::command]
async fn fs_write_text_file_cmd(
    state: State<'_, AppState>,
    path: String,
    text: String,
) -> Result<(), String> {
    state.fs.write_text_file(&path, &text).await
}

#[tauri::command]
async fn fs_create_directory_cmd(
    state: State<'_, AppState>,
    path: String,
    recursive: Option<bool>,
) -> Result<(), String> {
    state.fs.create_directory(&path, recursive).await
}

#[tauri::command]
async fn fs_get_metadata_cmd(
    state: State<'_, AppState>,
    path: String,
) -> Result<FileMetadata, String> {
    state.fs.get_metadata(&path).await
}

#[tauri::command]
async fn fs_remove_cmd(
    state: State<'_, AppState>,
    path: String,
    force: Option<bool>,
    recursive: Option<bool>,
) -> Result<(), String> {
    state.fs.remove(&path, force, recursive).await
}

#[tauri::command]
async fn fs_copy_cmd(
    state: State<'_, AppState>,
    source_path: String,
    destination_path: String,
    recursive: Option<bool>,
) -> Result<(), String> {
    state
        .fs
        .copy(&source_path, &destination_path, recursive)
        .await
}

#[tauri::command]
async fn fs_watch_cmd(
    state: State<'_, AppState>,
    path: String,
    watch_id: Option<String>,
) -> Result<WatchHandle, String> {
    state.fs.watch(&path, watch_id).await
}

#[tauri::command]
async fn fs_unwatch_cmd(state: State<'_, AppState>, watch_id: String) -> Result<(), String> {
    state.fs.unwatch(&watch_id).await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitStatusDto {
    branch: Option<String>,
    dirty: bool,
    ahead: i64,
    behind: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitDiffFileDto {
    path: String,
    /// XY-style short status from porcelain (e.g. "M ", "A ", "??").
    status: String,
    staged: bool,
    unstaged: bool,
    patch: String,
}

async fn git_output(cwd: &str, args: &[&str]) -> Result<String, String> {
    let output = tokio::process::Command::new("git")
        .args(["-C", cwd])
        .args(args)
        .output()
        .await
        .map_err(|e| format!("无法运行 git：{e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("git {:?} 失败", args)
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn require_repo_cwd(cwd: &str) -> Result<String, String> {
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return Err("工作目录为空".into());
    }
    if !std::path::Path::new(cwd).is_absolute() {
        return Err(format!("需要绝对路径：{cwd}"));
    }
    Ok(cwd.to_string())
}

#[tauri::command]
async fn get_git_status_cmd(cwd: String) -> Result<Option<GitStatusDto>, String> {
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return Ok(None);
    }
    let output = tokio::process::Command::new("git")
        .args([
            "-C",
            cwd,
            "status",
            "--porcelain=v1",
            "--branch",
            "--ahead-behind",
        ])
        .output()
        .await
        .map_err(|e| format!("无法运行 git：{e}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut branch = None;
    let mut ahead = 0i64;
    let mut behind = 0i64;
    let mut dirty = false;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            let name = rest.split("...").next().unwrap_or(rest).trim();
            branch = Some(name.to_string());
            if let Some(idx) = rest.find('[') {
                let bracket = &rest[idx..];
                if let Some(a) = bracket.split("ahead ").nth(1) {
                    ahead = a
                        .chars()
                        .take_while(|c| c.is_ascii_digit())
                        .collect::<String>()
                        .parse()
                        .unwrap_or(0);
                }
                if let Some(b) = bracket.split("behind ").nth(1) {
                    behind = b
                        .chars()
                        .take_while(|c| c.is_ascii_digit())
                        .collect::<String>()
                        .parse()
                        .unwrap_or(0);
                }
            }
        } else if !line.is_empty() {
            dirty = true;
        }
    }
    Ok(Some(GitStatusDto {
        branch,
        dirty,
        ahead,
        behind,
    }))
}

#[tauri::command]
async fn get_git_diff_cmd(cwd: String) -> Result<Vec<GitDiffFileDto>, String> {
    let cwd = require_repo_cwd(&cwd)?;
    let porcelain = git_output(&cwd, &["status", "--porcelain=v1"]).await?;
    let mut files: Vec<GitDiffFileDto> = Vec::new();
    for line in porcelain.lines() {
        if line.len() < 4 {
            continue;
        }
        let status = line[..2].to_string();
        let rest = line[3..].trim();
        // rename: "R  old -> new"
        let path = if let Some((_, new)) = rest.split_once(" -> ") {
            new.trim().to_string()
        } else {
            rest.to_string()
        };
        if path.is_empty() {
            continue;
        }
        let index_ch = status.chars().next().unwrap_or(' ');
        let work_ch = status.chars().nth(1).unwrap_or(' ');
        let staged = index_ch != ' ' && index_ch != '?';
        let unstaged = work_ch != ' ' || index_ch == '?';
        let mut patch = String::new();
        if staged {
            if let Ok(p) = git_output(&cwd, &["diff", "--cached", "--", &path]).await {
                if !p.trim().is_empty() {
                    patch.push_str(&p);
                }
            }
        }
        if unstaged {
            if index_ch == '?' {
                // Untracked: unified diff via --no-index is awkward cross-platform; show marker.
                if patch.is_empty() {
                    patch = format!("(未跟踪文件) {path}\n");
                }
            } else if let Ok(p) = git_output(&cwd, &["diff", "--", &path]).await {
                if !p.trim().is_empty() {
                    if !patch.is_empty() {
                        patch.push('\n');
                    }
                    patch.push_str(&p);
                }
            }
        }
        files.push(GitDiffFileDto {
            path,
            status,
            staged,
            unstaged,
            patch,
        });
    }
    Ok(files)
}

#[tauri::command]
async fn git_stage_cmd(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let cwd = require_repo_cwd(&cwd)?;
    let paths: Vec<String> = paths
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    if paths.is_empty() {
        return Err("没有要暂存的文件".into());
    }
    let mut args = vec!["add".to_string(), "--".to_string()];
    args.extend(paths);
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    git_output(&cwd, &arg_refs).await?;
    Ok(())
}

#[tauri::command]
async fn git_commit_cmd(cwd: String, message: String) -> Result<String, String> {
    let cwd = require_repo_cwd(&cwd)?;
    let message = message.trim();
    if message.is_empty() {
        return Err("提交说明不能为空".into());
    }
    git_output(&cwd, &["commit", "-m", message]).await
}

#[tauri::command]
async fn open_in_editor_cmd(
    state: State<'_, AppState>,
    path: String,
    editor: Option<String>,
) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("路径为空".into());
    }
    let from_arg = editor
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let editor = from_arg.unwrap_or_else(|| {
        state
            .settings
            .load()
            .map(|s| s.resolved_editor_command())
            .unwrap_or_else(|| AppSettings::default_editor_command().to_string())
    });
    let status = tokio::process::Command::new(&editor)
        .arg(path)
        .status()
        .await
        .map_err(|e| {
            format!(
                "无法启动编辑器「{editor}」：{e}。请安装 VS Code，或在设置中填写 editorCommand。"
            )
        })?;
    if !status.success() {
        return Err(format!("编辑器退出码：{}", status.code().unwrap_or(-1)));
    }
    Ok(())
}

#[tauri::command]
async fn fuzzy_file_search_cmd(
    state: State<'_, AppState>,
    query: String,
    roots: Vec<String>,
    cancellation_token: Option<String>,
) -> Result<FuzzySearchResult, String> {
    state
        .fs
        .fuzzy_file_search(&query, roots, cancellation_token)
        .await
}

#[tauri::command]
fn list_cron_jobs_cmd(state: State<'_, AppState>) -> Vec<CronJob> {
    state.cron.list_jobs()
}

#[tauri::command]
fn upsert_cron_job_cmd(
    state: State<'_, AppState>,
    input: UpsertCronJobInput,
) -> Result<CronJob, String> {
    state.cron.upsert_job(input)
}

#[tauri::command]
fn delete_cron_job_cmd(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.cron.delete_job(&id)
}

#[tauri::command]
fn set_cron_job_enabled_cmd(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<CronJob, String> {
    state.cron.set_enabled(&id, enabled)
}

#[tauri::command]
async fn run_cron_job_now_cmd(
    state: State<'_, AppState>,
    id: String,
) -> Result<ResultOrError, String> {
    Ok(state.cron.run_job_now(id).await)
}

#[tauri::command]
fn list_dynamic_tools_cmd(state: State<'_, AppState>) -> DynamicToolsListResult {
    state.dynamic_tools.list_for_settings()
}

#[tauri::command]
fn set_dynamic_tools_config_cmd(
    state: State<'_, AppState>,
    patch: DynamicToolsConfigPatch,
) -> Result<DynamicToolsListResult, String> {
    state.dynamic_tools.set_config(patch)
}

#[tauri::command]
fn list_session_dynamic_tools_cmd(
    state: State<'_, AppState>,
    thread_id: String,
) -> DynamicToolsListResult {
    state.dynamic_tools.list_for_session(&thread_id)
}

#[tauri::command]
fn set_session_dynamic_tools_cmd(
    state: State<'_, AppState>,
    thread_id: String,
    patch: DynamicToolsConfigPatch,
) -> Result<DynamicToolsListResult, String> {
    state.dynamic_tools.set_session_override(&thread_id, patch)
}

#[tauri::command]
fn clear_session_dynamic_tools_cmd(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<DynamicToolsListResult, String> {
    state.dynamic_tools.clear_session_override(&thread_id)
}

#[tauri::command]
async fn respond_dynamic_tool_cmd(
    state: State<'_, AppState>,
    request_id: String,
    allowed: bool,
) -> Result<(), String> {
    state
        .runtime
        .respond_dynamic_tool(&request_id, allowed)
        .await;
    Ok(())
}

#[tauri::command]
async fn respond_tool_user_input_cmd(
    state: State<'_, AppState>,
    request_id: String,
    answers: serde_json::Value,
) -> Result<OkResult, String> {
    state
        .runtime
        .respond_tool_user_input(&request_id, answers)
        .await;
    Ok(OkResult { ok: true })
}

#[tauri::command]
async fn compact_thread_cmd(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<serde_json::Value, String> {
    let client = state.runtime.ensure_thread_resumed(&thread_id).await?;
    client.thread_compact_start(&thread_id).await
}

#[tauri::command]
async fn review_start_cmd(
    state: State<'_, AppState>,
    thread_id: String,
    target: serde_json::Value,
    delivery: Option<String>,
) -> Result<serde_json::Value, String> {
    let client = state.runtime.ensure_thread_resumed(&thread_id).await?;
    client
        .review_start(&thread_id, target, delivery.as_deref())
        .await
}

#[tauri::command]
async fn thread_goal_get_cmd(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<serde_json::Value, String> {
    let client = state.runtime.connected_client().await?;
    client.thread_goal_get(&thread_id).await
}

#[tauri::command]
async fn thread_goal_set_cmd(
    state: State<'_, AppState>,
    thread_id: String,
    objective: Option<String>,
    status: Option<String>,
    token_budget: Option<i64>,
) -> Result<serde_json::Value, String> {
    let client = state.runtime.ensure_thread_resumed(&thread_id).await?;
    client
        .thread_goal_set(
            &thread_id,
            objective.as_deref(),
            status.as_deref(),
            token_budget,
        )
        .await
}

#[tauri::command]
async fn thread_goal_clear_cmd(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<serde_json::Value, String> {
    let client = state.runtime.ensure_thread_resumed(&thread_id).await?;
    client.thread_goal_clear(&thread_id).await
}

#[tauri::command]
async fn command_exec_cmd(
    app: AppHandle,
    state: State<'_, AppState>,
    command: Vec<String>,
    cwd: Option<String>,
    process_id: Option<String>,
    tty: Option<bool>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<serde_json::Value, String> {
    let tty = tty.unwrap_or(false);
    let client = state.runtime.connected_client().await?;

    // `command/exec` only returns when the process exits. For interactive TTY
    // sessions, start it in the background so write/resize/terminate can run
    // while the original request stays pending.
    if tty {
        let pid = process_id
            .clone()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| "交互终端需要 processId".to_string())?;
        let cwd_owned = cwd.clone();
        let cols = cols;
        let rows = rows;
        let pid_for_task = pid.clone();
        tokio::spawn(async move {
            let result = client
                .command_exec(
                    command,
                    cwd_owned.as_deref(),
                    Some(pid_for_task.as_str()),
                    true,
                    cols,
                    rows,
                )
                .await;
            let payload = match result {
                Ok(value) => serde_json::json!({
                    "processId": pid_for_task,
                    "ok": true,
                    "result": value,
                }),
                Err(err) => serde_json::json!({
                    "processId": pid_for_task,
                    "ok": false,
                    "error": err,
                }),
            };
            let _ = app.emit("codex:commandExecDone", payload);
        });
        return Ok(serde_json::json!({ "started": true, "processId": pid }));
    }

    client
        .command_exec(
            command,
            cwd.as_deref(),
            process_id.as_deref(),
            false,
            cols,
            rows,
        )
        .await
}

#[tauri::command]
async fn command_exec_write_cmd(
    state: State<'_, AppState>,
    process_id: String,
    data_base64: String,
) -> Result<serde_json::Value, String> {
    let client = state.runtime.connected_client().await?;
    client.command_exec_write(&process_id, &data_base64).await
}

#[tauri::command]
async fn command_exec_resize_cmd(
    state: State<'_, AppState>,
    process_id: String,
    cols: u16,
    rows: u16,
) -> Result<serde_json::Value, String> {
    let client = state.runtime.connected_client().await?;
    client.command_exec_resize(&process_id, cols, rows).await
}

#[tauri::command]
async fn command_exec_terminate_cmd(
    state: State<'_, AppState>,
    process_id: String,
) -> Result<serde_json::Value, String> {
    let client = state.runtime.connected_client().await?;
    client.command_exec_terminate(&process_id).await
}

#[tauri::command]
async fn plugin_read_cmd(
    state: State<'_, AppState>,
    plugin_name: String,
    marketplace_path: Option<String>,
    remote_marketplace_name: Option<String>,
) -> Result<serde_json::Value, String> {
    state
        .plugins
        .read(plugin_name, marketplace_path, remote_marketplace_name)
        .await
}

#[tauri::command]
async fn add_plugin_scheduled_task_cmd(
    state: State<'_, AppState>,
    plugin_name: String,
    marketplace_path: Option<String>,
    remote_marketplace_name: Option<String>,
    task_key: String,
    project_id: Option<String>,
) -> Result<CronJob, String> {
    state
        .plugins
        .add_scheduled_task(
            &state.cron,
            plugin_name,
            marketplace_path,
            remote_marketplace_name,
            task_key,
            project_id,
        )
        .await
}

#[tauri::command]
fn get_autostart_enabled_cmd(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch()
        .is_enabled()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart_enabled_cmd(app: AppHandle, enabled: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let launcher = app.autolaunch();
    if enabled {
        launcher.enable().map_err(|e| e.to_string())?;
    } else {
        launcher.disable().map_err(|e| e.to_string())?;
    }
    launcher.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_preview_focus_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state.preview.set_focus_session(&session_id);
    Ok(())
}

#[tauri::command]
async fn open_preview_window(
    state: State<'_, AppState>,
    url: String,
    session_id: String,
    instance_id: String,
    force_navigate: Option<bool>,
) -> Result<(), String> {
    state.preview.open_or_navigate(
        &url,
        &session_id,
        &instance_id,
        force_navigate.unwrap_or(true),
    )
}

#[tauri::command]
async fn close_preview_window(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state.preview.destroy_window(&session_id)
}

#[tauri::command]
async fn preview_content_navigate(
    state: State<'_, AppState>,
    session_id: String,
    url: String,
) -> Result<(), String> {
    state
        .preview
        .navigate_content(&session_id, &url)
}

#[tauri::command]
async fn preview_content_back(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state.preview.history_back(&session_id)
}

#[tauri::command]
async fn preview_content_forward(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state
        .preview
        .history_forward(&session_id)
}

#[tauri::command]
async fn preview_content_reload(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state.preview.reload(&session_id)
}

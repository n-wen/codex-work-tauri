//! Desktop Dynamic Tools bus: catalog, settings switches, wire specs, dispatch.
//!
//! Protocol: inject `dynamicTools` on thread/start|resume; handle `item/tool/call`.
//! See docs/codex-work/DynamicTools.md.

use crate::app_server::generated::dynamic_tool_call_response::{
    DynamicToolCallOutputContentItem, DynamicToolCallResponse,
};
use crate::host::cron::{
    CronJobSource, CronOrigin, CronRepeat, CronService, UpsertCronJobInput,
};
use crate::host::preview::Preview;
use super::store::{
    atomic_write_json, get_dynamic_tools_config_path, get_dynamic_tools_overrides_path,
    read_json_file,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::process::Command;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SideEffect {
    None,
    Mutate,
}

#[derive(Debug, Clone)]
pub struct ToolMeta {
    pub namespace: &'static str,
    pub namespace_label: &'static str,
    pub namespace_description: &'static str,
    pub name: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
    pub side_effect: SideEffect,
    pub confirm: bool,
}

#[derive(Clone)]
pub struct DispatchCtx {
    pub thread_id: String,
    #[allow(dead_code)]
    pub turn_id: String,
    #[allow(dead_code)]
    pub call_id: String,
    pub project_id: Option<String>,
    pub scheduled: bool,
    pub cron: Arc<CronService>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicToolListItem {
    pub namespace: String,
    pub namespace_label: String,
    pub namespace_description: String,
    pub namespace_enabled: bool,
    pub name: String,
    pub label: String,
    pub description: String,
    pub side_effect: String,
    pub confirm: bool,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicToolsListResult {
    pub enabled: bool,
    pub tools: Vec<DynamicToolListItem>,
    #[serde(default)]
    pub has_session_override: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SessionOverrideFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
    #[serde(default)]
    namespaces: BTreeMap<String, SessionNamespaceOverride>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SessionNamespaceOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
    #[serde(default)]
    tools: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicToolsConfigPatch {
    pub enabled: bool,
    pub namespaces: BTreeMap<String, DynamicToolsNamespacePatch>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicToolsNamespacePatch {
    pub enabled: bool,
    #[serde(default)]
    pub tools: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicToolConfirmRequest {
    pub request_id: String,
    pub call_id: String,
    pub namespace: Option<String>,
    pub tool: String,
    pub summary: String,
    pub arguments: Value,
}

pub struct DynamicTools {
    preview: Arc<Preview>,
}

impl DynamicTools {
    pub fn new(preview: Arc<Preview>) -> Self {
        Self { preview }
    }

    pub fn thread_developer_instructions() -> Option<String> {
        Self::developer_instructions_text()
    }

    pub fn specs() -> Vec<Value> {
        Self::specs_for_thread(None)
    }

    pub fn specs_for_thread(thread_id: Option<&str>) -> Vec<Value> {
        Self::wire_specs(thread_id)
    }

    pub fn is_tool_enabled(namespace: Option<&str>, name: &str) -> bool {
        Self::tool_is_enabled(None, namespace, name)
    }

    pub fn is_tool_enabled_for(
        thread_id: Option<&str>,
        namespace: Option<&str>,
        name: &str,
    ) -> bool {
        Self::tool_is_enabled(thread_id, namespace, name)
    }

    pub fn text_result(success: bool, text: impl Into<String>) -> DynamicToolCallResponse {
        Self::make_text_result(success, text)
    }

    pub fn needs_confirm(namespace: Option<&str>, tool: &str) -> bool {
        Self::tool_needs_confirm(namespace, tool)
    }

    pub fn preview_summary(
        namespace: Option<&str>,
        tool: &str,
        args: &Value,
        ctx: &DispatchCtx,
    ) -> String {
        Self::summarize_tool(namespace, tool, args, ctx)
    }

    pub fn list_for_settings(&self) -> DynamicToolsListResult {
        Self::settings_list()
    }

    pub fn set_config(&self, patch: DynamicToolsConfigPatch) -> Result<DynamicToolsListResult, String> {
        Self::apply_config(patch)
    }

    pub fn list_for_session(&self, thread_id: &str) -> DynamicToolsListResult {
        Self::settings_list_for(Some(thread_id))
    }

    pub fn set_session_override(
        &self,
        thread_id: &str,
        patch: DynamicToolsConfigPatch,
    ) -> Result<DynamicToolsListResult, String> {
        Self::apply_session_override(thread_id, patch)
    }

    pub fn clear_session_override(&self, thread_id: &str) -> Result<DynamicToolsListResult, String> {
        Self::remove_session_override(thread_id)
    }

    pub fn dispatch(
        &self,
        namespace: Option<&str>,
        tool: &str,
        args: &Value,
        ctx: &DispatchCtx,
    ) -> DynamicToolCallResponse {
        if ctx.scheduled {
            return Self::make_text_result(false, "定时执行轮次不能使用桌面工具");
        }

        let Some(meta) = Self::resolve_meta(namespace, tool) else {
            return Self::make_text_result(false, format!("未知工具：{}", tool));
        };

        if !Self::tool_is_enabled(Some(ctx.thread_id.as_str()), Some(meta.namespace), meta.name) {
            return Self::make_text_result(false, "工具已在设置中关闭");
        }

        match (meta.namespace, meta.name) {
            ("cron", "list") => Self::cron_list(ctx),
            ("cron", "upsert") => Self::cron_upsert(args, ctx),
            ("cron", "set_enabled") => Self::cron_set_enabled(args, ctx),
            ("cron", "delete") => Self::cron_delete(args, ctx),
            ("cron", "run_now") => Self::cron_run_now(args, ctx),
            ("preview", "open") => self.preview_open(args, ctx),
            ("preview", "close") => self.preview_close(ctx),
            ("desktop", "openPath") => Self::desktop_open_path(args),
            ("desktop", "revealInDir") => Self::desktop_reveal_in_dir(args),
            ("desktop", "openInEditor") => Self::desktop_open_in_editor(args),
            _ => Self::make_text_result(false, format!("未实现：{}.{}", meta.namespace, meta.name)),
        }
    }

    fn preview_open(&self, args: &Value, ctx: &DispatchCtx) -> DynamicToolCallResponse {
        let url = match Self::arg_str(args, "url") {
            Some(s) => s,
            None => return Self::make_text_result(false, "缺少 url"),
        };
        match self.preview.open_sidebar(&url, &ctx.thread_id) {
            Ok(msg) => Self::make_text_result(true, msg),
            Err(e) => Self::make_text_result(false, e),
        }
    }

    fn preview_close(&self, ctx: &DispatchCtx) -> DynamicToolCallResponse {
        match self.preview.close_sidebar(&ctx.thread_id) {
            Ok(msg) => Self::make_text_result(true, msg),
            Err(e) => Self::make_text_result(false, e),
        }
    }

    fn desktop_open_path(args: &Value) -> DynamicToolCallResponse {
        let path = match Self::arg_str(args, "path") {
            Some(s) => s,
            None => return Self::make_text_result(false, "缺少 path"),
        };
        match Self::os_open_path(&path) {
            Ok(()) => Self::make_text_result(true, format!("已打开：{path}")),
            Err(e) => Self::make_text_result(false, e),
        }
    }

    fn desktop_reveal_in_dir(args: &Value) -> DynamicToolCallResponse {
        let path = match Self::arg_str(args, "path") {
            Some(s) => s,
            None => return Self::make_text_result(false, "缺少 path"),
        };
        match Self::os_reveal_in_dir(&path) {
            Ok(()) => Self::make_text_result(true, format!("已在资源管理器中显示：{path}")),
            Err(e) => Self::make_text_result(false, e),
        }
    }

    fn desktop_open_in_editor(args: &Value) -> DynamicToolCallResponse {
        let path = match Self::arg_str(args, "path") {
            Some(s) => s,
            None => return Self::make_text_result(false, "缺少 path"),
        };
        let editor = Self::arg_str(args, "editor").unwrap_or_else(|| {
            crate::host::settings::Settings::new()
                .load()
                .map(|s| s.resolved_editor_command())
                .unwrap_or_else(|| {
                    crate::host::settings::AppSettings::default_editor_command().to_string()
                })
        });
        match Command::new(&editor).arg(&path).status() {
            Ok(status) if status.success() => {
                Self::make_text_result(true, format!("已在编辑器打开：{path}"))
            }
            Ok(status) => Self::make_text_result(
                false,
                format!("编辑器退出码：{}", status.code().unwrap_or(-1)),
            ),
            Err(e) => Self::make_text_result(
                false,
                format!(
                    "无法启动编辑器「{editor}」：{e}。请安装编辑器或在设置中填写 editorCommand。"
                ),
            ),
        }
    }

    fn os_open_path(path: &str) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            Command::new("cmd")
                .args(["/C", "start", "", path])
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("打开失败：{e}"))
        }
        #[cfg(target_os = "macos")]
        {
            Command::new("open")
                .arg(path)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("打开失败：{e}"))
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            Command::new("xdg-open")
                .arg(path)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("打开失败：{e}"))
        }
    }

    fn os_reveal_in_dir(path: &str) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            Command::new("explorer")
                .args(["/select,", path])
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("显示失败：{e}"))
        }
        #[cfg(target_os = "macos")]
        {
            Command::new("open")
                .args(["-R", path])
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("显示失败：{e}"))
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            // Best-effort: open parent directory.
            let parent = std::path::Path::new(path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| path.to_string());
            Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("显示失败：{e}"))
        }
    }

    fn desktop_input_schema_path() -> Value {
        json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": { "type": "string", "description": "Absolute file or directory path" }
            },
            "additionalProperties": false
        })
    }

    fn desktop_input_schema_editor() -> Value {
        json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": { "type": "string", "description": "Absolute file or directory path" },
                "editor": {
                    "type": "string",
                    "description": "Editor command (default: code / code.cmd)"
                }
            },
            "additionalProperties": false
        })
    }

    fn load_config() -> ConfigFile {
    read_json_file(&get_dynamic_tools_config_path(), ConfigFile::default())
    }

    fn save_config(file: &ConfigFile) -> Result<(), String> {
    atomic_write_json(&get_dynamic_tools_config_path(), file)
    }

    fn cron_input_schema_list() -> Value {
    json!({
        "type": "object",
        "properties": {},
        "additionalProperties": false
    })
    }

    fn cron_input_schema_upsert() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": { "type": "string", "description": "Existing job id from cron.list; omit to create" },
            "name": { "type": "string" },
            "prompt": { "type": "string", "description": "Prompt sent when the job runs" },
            "cronExpr": { "type": "string", "description": "5-field cron (min hour day month weekday)" },
            "schedulePreset": {
                "type": "string",
                "enum": ["hourly", "daily", "weekdays", "weekly"],
                "description": "UI preset; prefer over cronExpr when possible"
            },
            "time": { "type": "string", "description": "HH:MM for daily/weekdays/weekly" },
            "intervalHours": { "type": "integer", "minimum": 1 },
            "days": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Weekdays like MO,WE for weekly"
            },
            "enabled": { "type": "boolean" },
            "origin": { "type": "string", "enum": ["newInProject", "bindExisting"] },
            "repeat": { "type": "string", "enum": ["alwaysNew", "reuseFirst"] },
            "threadId": { "type": "string", "description": "Required when origin=bindExisting" },
            "projectId": { "type": "string" }
        },
        "required": ["name", "prompt"],
        "additionalProperties": false
    })
    }

    fn cron_input_schema_set_enabled() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": { "type": "string" },
            "enabled": { "type": "boolean" }
        },
        "required": ["id", "enabled"],
        "additionalProperties": false
    })
    }

    fn cron_input_schema_delete() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": { "type": "string" }
        },
        "required": ["id"],
        "additionalProperties": false
    })
    }

    fn cron_input_schema_run_now() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": {
                "type": "string",
                "description": "Job id from cron.list"
            }
        },
        "required": ["id"],
        "additionalProperties": false
    })
    }

    fn preview_input_schema_open() -> Value {
    json!({
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "http(s) URL such as http://localhost:5173 or https://example.com"
            }
        },
        "required": ["url"],
        "additionalProperties": false
    })
    }

    fn preview_input_schema_close() -> Value {
    json!({
        "type": "object",
        "properties": {},
        "additionalProperties": false
    })
    }

    const PREVIEW_DEVELOPER_INSTRUCTIONS: &str = "\
    When you start or update a local web app (Vite/Next/etc.), after the URL is reachable \
    call the desktop tool `preview.open` with that http(s) URL (e.g. http://127.0.0.1:5173). \
    Any http(s) URL is allowed. This opens the right-hand Preview sidebar panel (iframe) for \
    the current chat session. Use `preview.close` to dismiss this session's preview panel. \
    Each session keeps its own preview URL/open state. Do not ask the user to paste the URL \
    manually unless the tool fails. \
    IMPORTANT: This Codex Work client has NO Browser / Chrome / Computer Use surface for you. \
    After `preview.open` returns ok, treat the sidebar Preview panel as verification and STOP. \
    Do not call node_repl `js`, browser skills, Chrome skills, or computer-use to screenshot \
    or navigate the page. A successful `curl` HTTP 200 is enough if you need a reachability check.";

    const NO_BROWSER_INSTRUCTIONS: &str = "\
    IMPORTANT: This Codex Work client has NO Browser / Chrome / Computer Use surface for you. \
    Do not call node_repl `js`, browser skills, Chrome skills, or computer-use to screenshot \
    or navigate pages.";

    /// Injected on user thread/start|resume. Preview how-to only when that namespace is on.
    fn developer_instructions_text() -> Option<String> {
    if Self::tool_is_enabled(None, Some("preview"), "open") {
        Some(Self::PREVIEW_DEVELOPER_INSTRUCTIONS.to_string())
    } else {
        Some(Self::NO_BROWSER_INSTRUCTIONS.to_string())
    }
    }

    /// Code catalog — only these appear in settings / specs.
    fn catalog() -> Vec<ToolMeta> {
    vec![
        ToolMeta {
            namespace: "cron",
            namespace_label: "已安排",
            namespace_description: "在对话里创建与管理本机定时任务（应用未运行会错过触发）",
            name: "list",
            label: "列出任务",
            description: "List local scheduled (cron) jobs: id, name, cronExpr, nextRunAt, enabled. App must be running for jobs to fire.",
            input_schema: Self::cron_input_schema_list(),
            side_effect: SideEffect::None,
            confirm: false,
        },
        ToolMeta {
            namespace: "cron",
            namespace_label: "已安排",
            namespace_description: "在对话里创建与管理本机定时任务（应用未运行会错过触发）",
            name: "upsert",
            label: "创建或更新任务",
            description: "Create or update a local scheduled job. Prefer schedulePreset+time over raw cronExpr. Defaults: newInProject + reuseFirst; does not bind to the current chat unless origin=bindExisting. To run immediately after creating, call cron.run_now with the returned id — do not change cronExpr just to trigger sooner.",
            input_schema: Self::cron_input_schema_upsert(),
            side_effect: SideEffect::Mutate,
            confirm: true,
        },
        ToolMeta {
            namespace: "cron",
            namespace_label: "已安排",
            namespace_description: "在对话里创建与管理本机定时任务（应用未运行会错过触发）",
            name: "set_enabled",
            label: "启用或停用",
            description: "Enable or disable a scheduled job by id from cron.list.",
            input_schema: Self::cron_input_schema_set_enabled(),
            side_effect: SideEffect::Mutate,
            confirm: true,
        },
        ToolMeta {
            namespace: "cron",
            namespace_label: "已安排",
            namespace_description: "在对话里创建与管理本机定时任务（应用未运行会错过触发）",
            name: "delete",
            label: "删除任务",
            description: "Delete a scheduled job by id from cron.list.",
            input_schema: Self::cron_input_schema_delete(),
            side_effect: SideEffect::Mutate,
            confirm: true,
        },
        ToolMeta {
            namespace: "cron",
            namespace_label: "已安排",
            namespace_description: "在对话里创建与管理本机定时任务（应用未运行会错过触发）",
            name: "run_now",
            label: "立即执行",
            description: "Run a scheduled job once now (manual trigger). Does not change nextRunAt / cron schedule. If another turn is running, the job is queued and runs after. Prefer this over rewriting cronExpr to fire sooner. Requires job id from cron.list.",
            input_schema: Self::cron_input_schema_run_now(),
            side_effect: SideEffect::Mutate,
            confirm: true,
        },
        ToolMeta {
            namespace: "preview",
            namespace_label: "预览",
            namespace_description: "打开或关闭当前对话右侧 Preview 侧栏（iframe），用于查看本地或远程网页",
            name: "open",
            label: "打开预览",
            description: "Open the Codex Work right-hand Preview sidebar (iframe) for the current chat session. Each session keeps its own panel URL/open state. Call once when an http(s) URL is ready (local or remote). On success the sidebar is already open for the user — do not follow up with browser/node_repl/Chrome tools to verify.",
            input_schema: Self::preview_input_schema_open(),
            side_effect: SideEffect::None,
            confirm: false,
        },
        ToolMeta {
            namespace: "preview",
            namespace_label: "预览",
            namespace_description: "打开或关闭当前对话右侧 Preview 侧栏（iframe），用于查看本地或远程网页",
            name: "close",
            label: "关闭预览",
            description: "Close this chat session's Codex Work Preview sidebar panel (other sessions are left alone).",
            input_schema: Self::preview_input_schema_close(),
            side_effect: SideEffect::None,
            confirm: false,
        },
        ToolMeta {
            namespace: "desktop",
            namespace_label: "桌面",
            namespace_description: "在本机用系统默认应用或编辑器打开路径",
            name: "openPath",
            label: "打开路径",
            description: "Open a local file or directory with the OS default application (same as double-clicking in the file manager).",
            input_schema: Self::desktop_input_schema_path(),
            side_effect: SideEffect::Mutate,
            confirm: true,
        },
        ToolMeta {
            namespace: "desktop",
            namespace_label: "桌面",
            namespace_description: "在本机用系统默认应用或编辑器打开路径",
            name: "revealInDir",
            label: "在资源管理器中显示",
            description: "Reveal a local file or directory in the system file manager (Explorer / Finder).",
            input_schema: Self::desktop_input_schema_path(),
            side_effect: SideEffect::None,
            confirm: false,
        },
        ToolMeta {
            namespace: "desktop",
            namespace_label: "桌面",
            namespace_description: "在本机用系统默认应用或编辑器打开路径",
            name: "openInEditor",
            label: "用编辑器打开",
            description: "Open a local path in VS Code (or another editor command). Defaults to `code` / `code.cmd`.",
            input_schema: Self::desktop_input_schema_editor(),
            side_effect: SideEffect::Mutate,
            confirm: true,
        },
    ]
    }

    fn tool_enabled(cfg: &ConfigFile, namespace: &str, name: &str) -> bool {
    if !cfg.enabled {
        return false;
    }
    let ns_enabled = cfg
        .namespaces
        .get(namespace)
        .map(|n| n.enabled)
        .unwrap_or(cfg.enabled);
    if !ns_enabled {
        return false;
    }
    match cfg
        .namespaces
        .get(namespace)
        .and_then(|n| n.tools.get(name))
    {
        Some(v) => *v,
        None => ns_enabled,
    }
    }

    fn load_overrides() -> BTreeMap<String, SessionOverrideFile> {
        read_json_file(
            &get_dynamic_tools_overrides_path(),
            BTreeMap::<String, SessionOverrideFile>::new(),
        )
    }

    fn save_overrides(map: &BTreeMap<String, SessionOverrideFile>) -> Result<(), String> {
        atomic_write_json(&get_dynamic_tools_overrides_path(), map)
    }

    fn effective_config(thread_id: Option<&str>) -> ConfigFile {
        let mut cfg = Self::load_config();
        let Some(tid) = thread_id.map(str::trim).filter(|s| !s.is_empty()) else {
            return cfg;
        };
        let Some(ov) = Self::load_overrides().get(tid).cloned() else {
            return cfg;
        };
        if let Some(enabled) = ov.enabled {
            cfg.enabled = enabled;
        }
        for (ns, nov) in ov.namespaces {
            let entry = cfg.namespaces.entry(ns).or_insert_with(|| NamespaceConfig {
                enabled: true,
                tools: BTreeMap::new(),
            });
            if let Some(ns_enabled) = nov.enabled {
                entry.enabled = ns_enabled;
            }
            for (tool, on) in nov.tools {
                entry.tools.insert(tool, on);
            }
        }
        cfg
    }

    fn tool_is_enabled(thread_id: Option<&str>, namespace: Option<&str>, name: &str) -> bool {
    let cfg = Self::effective_config(thread_id);
    let ns = namespace.unwrap_or("");
    let short = if !ns.is_empty() {
        name.strip_prefix(&format!("{ns}_")).unwrap_or(name)
    } else if let Some((a, rest)) = name.split_once('_') {
        if Self::catalog().iter().any(|t| t.namespace == a && t.name == rest) {
            return Self::tool_enabled(&cfg, a, rest);
        }
        name
    } else {
        name
    };
    if ns.is_empty() {
        return Self::catalog()
            .iter()
            .any(|t| t.name == name && Self::tool_enabled(&cfg, t.namespace, t.name));
    }
    Self::tool_enabled(&cfg, ns, short)
    }

    /// Wire `dynamicTools` for thread/start|resume (experimental). Empty if bus off.
    fn wire_specs(thread_id: Option<&str>) -> Vec<Value> {
    let cfg = Self::effective_config(thread_id);
    if !cfg.enabled {
        return Vec::new();
    }

    let mut by_ns: BTreeMap<&str, Vec<&ToolMeta>> = BTreeMap::new();
    let cat = Self::catalog();
    let enabled: Vec<&ToolMeta> = cat
        .iter()
        .filter(|t| Self::tool_enabled(&cfg, t.namespace, t.name))
        .collect();
    if enabled.is_empty() {
        return Vec::new();
    }

    for t in &enabled {
        by_ns.entry(t.namespace).or_default().push(*t);
    }

    let mut out = Vec::new();
    for (ns, tools) in by_ns {
        let first = tools[0];
        let tool_objs: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "name": t.name,
                    "description": t.description,
                    "inputSchema": t.input_schema,
                })
            })
            .collect();
        out.push(json!({
            "type": "namespace",
            "name": ns,
            "description": first.namespace_description,
            "tools": tool_objs,
        }));
    }
    out
    }

    fn settings_list() -> DynamicToolsListResult {
        Self::settings_list_for(None)
    }

    fn settings_list_for(thread_id: Option<&str>) -> DynamicToolsListResult {
    let cfg = Self::effective_config(thread_id);
    let tools = Self::catalog()
        .into_iter()
        .map(|t| {
            let ns_enabled = cfg
                .namespaces
                .get(t.namespace)
                .map(|n| n.enabled)
                .unwrap_or(cfg.enabled);
            let tool_switch = match cfg
                .namespaces
                .get(t.namespace)
                .and_then(|n| n.tools.get(t.name))
            {
                Some(v) => *v,
                None => ns_enabled,
            };
            DynamicToolListItem {
                namespace: t.namespace.into(),
                namespace_label: t.namespace_label.into(),
                namespace_description: t.namespace_description.into(),
                namespace_enabled: ns_enabled,
                name: t.name.into(),
                label: t.label.into(),
                description: t.description.into(),
                side_effect: match t.side_effect {
                    SideEffect::None => "none".into(),
                    SideEffect::Mutate => "mutate".into(),
                },
                confirm: t.confirm,
                enabled: tool_switch,
            }
        })
        .collect();
    DynamicToolsListResult {
        enabled: cfg.enabled,
        tools,
        has_session_override: thread_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|tid| Self::load_overrides().contains_key(tid))
            .unwrap_or(false),
    }
    }

    fn apply_session_override(
        thread_id: &str,
        patch: DynamicToolsConfigPatch,
    ) -> Result<DynamicToolsListResult, String> {
        let tid = thread_id.trim();
        if tid.is_empty() {
            return Err("会话 id 不能为空".into());
        }
        let mut map = Self::load_overrides();
        let mut ov = SessionOverrideFile::default();
        ov.enabled = Some(patch.enabled);
        for (ns, ncfg) in patch.namespaces {
            ov.namespaces.insert(
                ns,
                SessionNamespaceOverride {
                    enabled: Some(ncfg.enabled),
                    tools: ncfg.tools,
                },
            );
        }
        map.insert(tid.to_string(), ov);
        Self::save_overrides(&map)?;
        Ok(Self::settings_list_for(Some(tid)))
    }

    fn remove_session_override(thread_id: &str) -> Result<DynamicToolsListResult, String> {
        let tid = thread_id.trim();
        if tid.is_empty() {
            return Err("会话 id 不能为空".into());
        }
        let mut map = Self::load_overrides();
        map.remove(tid);
        Self::save_overrides(&map)?;
        Ok(Self::settings_list_for(Some(tid)))
    }

    fn apply_config(patch: DynamicToolsConfigPatch) -> Result<DynamicToolsListResult, String> {
    let cat = Self::catalog();
    let known_ns: BTreeMap<&str, Vec<&str>> = {
        let mut m: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for t in &cat {
            m.entry(t.namespace).or_default().push(t.name);
        }
        m
    };

    let mut namespaces = BTreeMap::new();
    for (ns, ns_patch) in patch.namespaces {
        let Some(tool_names) = known_ns.get(ns.as_str()) else {
            continue;
        };
        let mut tools = BTreeMap::new();
        for (name, on) in ns_patch.tools {
            if tool_names.contains(&name.as_str()) {
                tools.insert(name, on);
            }
        }
        namespaces.insert(
            ns,
            NamespaceConfig {
                enabled: ns_patch.enabled,
                tools,
            },
        );
    }

    let file = ConfigFile {
        version: 1,
        enabled: patch.enabled,
        namespaces,
    };
    Self::save_config(&file)?;
    Ok(Self::settings_list())
    }

    fn resolve_meta(namespace: Option<&str>, tool: &str) -> Option<ToolMeta> {
    let cat = Self::catalog();
    if let Some(ns) = namespace.filter(|s| !s.is_empty()) {
        return cat
            .into_iter()
            .find(|t| t.namespace == ns && t.name == tool);
    }
    // Flat: cron_list or unique short name
    if let Some((ns, name)) = tool.split_once('_') {
        if let Some(t) = cat.iter().find(|t| t.namespace == ns && t.name == name) {
            return Some(t.clone());
        }
    }
    let matches: Vec<_> = cat.into_iter().filter(|t| t.name == tool).collect();
    if matches.len() == 1 {
        Some(matches.into_iter().next().unwrap())
    } else {
        None
    }
    }

    fn make_text_result(success: bool, text: impl Into<String>) -> DynamicToolCallResponse {
    DynamicToolCallResponse {
        success,
        content_items: vec![DynamicToolCallOutputContentItem::InputText { text: text.into() }],
    }
    }

    fn tool_needs_confirm(namespace: Option<&str>, tool: &str) -> bool {
    Self::resolve_meta(namespace, tool)
        .map(|t| t.confirm)
        .unwrap_or(false)
    }

    fn summarize_tool(
    namespace: Option<&str>,
    tool: &str,
    args: &Value,
    ctx: &DispatchCtx,
    ) -> String {
    let meta = match Self::resolve_meta(namespace, tool) {
        Some(m) => m,
        None => return format!("未知工具：{}", tool),
    };
    match (meta.namespace, meta.name) {
        ("cron", "upsert") => Self::preview_cron_upsert(args, ctx),
        ("cron", "set_enabled") => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("?");
            let en = args
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            format!("{} 任务 {id}", if en { "启用" } else { "停用" })
        }
        ("cron", "delete") => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("?");
            format!("删除任务 {id}")
        }
        ("cron", "run_now") => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("?");
            let name = ctx
                .cron
                .get_job(id)
                .map(|j| j.name)
                .unwrap_or_else(|| id.to_string());
            format!("立即执行任务「{name}」（{id}）\n不会改周期 nextRunAt；若当前对话忙则排队")
        }
        ("preview", "open") => {
            let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("?");
            format!("打开侧栏预览 {url}")
        }
        ("preview", "close") => "关闭当前会话的侧栏预览".into(),
        ("desktop", "openPath") => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("?");
            format!("用系统默认应用打开 {path}")
        }
        ("desktop", "revealInDir") => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("?");
            format!("在资源管理器中显示 {path}")
        }
        ("desktop", "openInEditor") => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("?");
            format!("用编辑器打开 {path}")
        }
        _ => format!("{}.{}", meta.namespace, meta.name),
    }
    }

    fn preview_cron_upsert(args: &Value, ctx: &DispatchCtx) -> String {
    let name = args
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("(未命名)");
    let prompt = args.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
    let prompt_short = if prompt.chars().count() > 80 {
        format!("{}…", prompt.chars().take(80).collect::<String>())
    } else {
        prompt.to_string()
    };
    let rhythm = if let Some(p) = args.get("schedulePreset").and_then(|v| v.as_str()) {
        let time = args.get("time").and_then(|v| v.as_str()).unwrap_or("");
        format!("{p} {time}").trim().to_string()
    } else {
        args.get("cronExpr")
            .and_then(|v| v.as_str())
            .unwrap_or("(未指定节奏)")
            .to_string()
    };
    let project = args
        .get("projectId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| ctx.project_id.clone())
        .unwrap_or_else(|| "(默认项目)".into());
    format!("创建/更新定时任务「{name}」\n节奏：{rhythm}\n项目：{project}\nPrompt：{prompt_short}")
    }

    fn cron_list(ctx: &DispatchCtx) -> DynamicToolCallResponse {
    let jobs = ctx.cron.list_jobs();
    let rows: Vec<Value> = jobs
        .into_iter()
        .map(|j| {
            json!({
                "id": j.id,
                "name": j.name,
                "cronExpr": j.cron_expr,
                "nextRunAt": j.next_run_at,
                "enabled": j.enabled,
                "origin": j.origin,
                "repeat": j.repeat,
                "projectId": j.project_id,
                "threadId": j.thread_id,
            })
        })
        .collect();
    Self::make_text_result(
        true,
        serde_json::to_string_pretty(&rows).unwrap_or_else(|_| "[]".into()),
    )
    }

    fn arg_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
    }

    fn cron_upsert(args: &Value, ctx: &DispatchCtx) -> DynamicToolCallResponse {
    let name = match Self::arg_str(args, "name") {
        Some(s) => s,
        None => return Self::make_text_result(false, "缺少 name"),
    };
    let prompt = match Self::arg_str(args, "prompt") {
        Some(s) => s,
        None => return Self::make_text_result(false, "缺少 prompt"),
    };

    let origin = match Self::arg_str(args, "origin").as_deref() {
        Some("bindExisting") => CronOrigin::BindExisting,
        _ => CronOrigin::NewInProject,
    };
    let repeat = match origin {
        CronOrigin::NewInProject => Some(match Self::arg_str(args, "repeat").as_deref() {
            Some("alwaysNew") => CronRepeat::AlwaysNew,
            _ => CronRepeat::ReuseFirst,
        }),
        CronOrigin::BindExisting => None,
    };

    let project_id = Self::arg_str(args, "projectId").or_else(|| ctx.project_id.clone());

    let input = UpsertCronJobInput {
        id: Self::arg_str(args, "id"),
        name,
        prompt,
        cron_expr: Self::arg_str(args, "cronExpr").unwrap_or_default(),
        schedule_preset: Self::arg_str(args, "schedulePreset"),
        time: Self::arg_str(args, "time"),
        interval_hours: args
            .get("intervalHours")
            .and_then(|v| v.as_u64())
            .map(|n| n as u32),
        days: args.get("days").and_then(|v| {
            v.as_array().map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
        }),
        once_at: None,
        enabled: args
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
        project_id,
        thread_id: Self::arg_str(args, "threadId"),
        origin,
        repeat,
        model: None,
        sandbox: None,
        approval_policy: Some("never".into()),
        timeout_mins: Some(30),
        source: Some(CronJobSource {
            kind: "user".into(),
            plugin_id: None,
            plugin_task_key: None,
        }),
    };

    match ctx.cron.upsert_job(input) {
        Ok(job) => Self::make_text_result(
            true,
            serde_json::to_string_pretty(&json!({
                "id": job.id,
                "name": job.name,
                "cronExpr": job.cron_expr,
                "nextRunAt": job.next_run_at,
                "enabled": job.enabled,
                "origin": job.origin,
                "repeat": job.repeat,
                "projectId": job.project_id,
            }))
            .unwrap_or_else(|_| "ok".into()),
        ),
        Err(e) => Self::make_text_result(false, e),
    }
    }

    fn cron_set_enabled(args: &Value, ctx: &DispatchCtx) -> DynamicToolCallResponse {
    let id = match Self::arg_str(args, "id") {
        Some(s) => s,
        None => return Self::make_text_result(false, "缺少 id"),
    };
    let enabled = match args.get("enabled").and_then(|v| v.as_bool()) {
        Some(b) => b,
        None => return Self::make_text_result(false, "缺少 enabled"),
    };
    match ctx.cron.set_enabled(&id, enabled) {
        Ok(job) => Self::make_text_result(
            true,
            format!(
                "已{}任务 {}（nextRunAt={:?}）",
                if enabled { "启用" } else { "停用" },
                job.id,
                job.next_run_at
            ),
        ),
        Err(e) => Self::make_text_result(false, e),
    }
    }

    fn cron_delete(args: &Value, ctx: &DispatchCtx) -> DynamicToolCallResponse {
    let id = match Self::arg_str(args, "id") {
        Some(s) => s,
        None => return Self::make_text_result(false, "缺少 id"),
    };
    match ctx.cron.delete_job(&id) {
        Ok(()) => Self::make_text_result(true, format!("已删除任务 {id}")),
        Err(e) => Self::make_text_result(false, e),
    }
    }

    fn cron_run_now(args: &Value, ctx: &DispatchCtx) -> DynamicToolCallResponse {
    let id = match Self::arg_str(args, "id") {
        Some(s) => s,
        None => return Self::make_text_result(false, "缺少 id"),
    };
    // Already connected in a live turn; try_run(manual) enqueues without shifting nextRunAt.
    let result = ctx.cron.try_run(&id, true);
    if result.ok {
        let queued = result.queued.unwrap_or(false);
        let msg = if queued {
            format!("已触发任务 {id}：已入队，将在当前对话结束后执行（未改动周期 nextRunAt）")
        } else {
            format!("已触发任务 {id}：将尽快执行（未改动周期 nextRunAt）")
        };
        Self::make_text_result(true, msg)
    } else {
        Self::make_text_result(false, result.error.unwrap_or_else(|| "立即执行失败".into()))
    }
    }
}


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigFile {
    version: u32,
    enabled: bool,
    #[serde(default)]
    namespaces: BTreeMap<String, NamespaceConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct NamespaceConfig {
    enabled: bool,
    #[serde(default)]
    tools: BTreeMap<String, bool>,
}

impl Default for ConfigFile {
    fn default() -> Self {
        Self {
            version: 1,
            enabled: true,
            namespaces: BTreeMap::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specs_default_includes_cron_and_preview_namespaces() {
        let s = DynamicTools::specs();
        assert!(!s.is_empty());
        let names: Vec<&str> = s
            .iter()
            .filter_map(|v| v.get("name").and_then(|n| n.as_str()))
            .collect();
        assert!(names.contains(&"cron"));
        assert!(names.contains(&"preview"));
        assert!(names.contains(&"desktop"));
        let cron = s.iter().find(|v| v["name"] == "cron").unwrap();
        assert_eq!(cron["type"], "namespace");
        assert!(cron["tools"].as_array().unwrap().len() >= 5);
        let preview = s.iter().find(|v| v["name"] == "preview").unwrap();
        let preview_tools: Vec<&str> = preview["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t.get("name").and_then(|n| n.as_str()))
            .collect();
        assert!(preview_tools.contains(&"open"));
        assert!(preview_tools.contains(&"close"));
        let desktop = s.iter().find(|v| v["name"] == "desktop").unwrap();
        let desktop_tools: Vec<&str> = desktop["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t.get("name").and_then(|n| n.as_str()))
            .collect();
        assert!(desktop_tools.contains(&"openPath"));
        assert!(desktop_tools.contains(&"revealInDir"));
        assert!(desktop_tools.contains(&"openInEditor"));
        let parsed: Vec<crate::app_server::generated::thread_start_params::DynamicToolSpec> =
            serde_json::from_value(Value::Array(s)).expect("specs match DynamicToolSpec");
        assert!(!parsed.is_empty());
    }
}

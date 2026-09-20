use dirs::data_dir;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

pub fn get_data_root() -> PathBuf {
    let root = data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("io.github.n-wen.codex-work")
        .join("codex-work");
    let _ = fs::create_dir_all(&root);
    root
}

pub fn get_projects_path() -> PathBuf {
    get_data_root().join("projects.json")
}

pub fn get_settings_path() -> PathBuf {
    get_data_root().join("settings.json")
}

pub fn get_cron_jobs_path() -> PathBuf {
    let dir = get_data_root().join("cron");
    let _ = fs::create_dir_all(&dir);
    dir.join("jobs.json")
}

pub fn get_dynamic_tools_config_path() -> PathBuf {
    get_data_root().join("dynamic-tools.json")
}

pub fn get_dynamic_tools_overrides_path() -> PathBuf {
    get_data_root().join("dynamic-tools-overrides.json")
}

pub fn get_chat_pending_path() -> PathBuf {
    get_data_root().join("chat-pending.json")
}

pub fn get_sessions_dir(project_id: &str) -> PathBuf {
    let dir = get_data_root().join("sessions").join(project_id);
    let _ = fs::create_dir_all(&dir);
    dir
}

pub fn read_json_file<T: DeserializeOwned>(path: &Path, fallback: T) -> T {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or(fallback),
        Err(_) => fallback,
    }
}

pub fn write_json_file<T: Serialize>(path: &Path, data: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

/// Write via temp file + rename so a crash mid-write cannot truncate the target.
pub fn atomic_write_json<T: Serialize>(path: &Path, data: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, raw).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

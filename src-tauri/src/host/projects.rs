use super::store::{get_projects_path, get_sessions_dir, read_json_file, write_json_file};
use crate::types::now_iso;
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub work_dir: String,
    /// When false, workspace exists for agent cwd but is hidden from the 项目 sidebar.
    #[serde(default = "default_listed")]
    pub listed: bool,
    pub created_at: String,
    pub updated_at: String,
}

fn default_listed() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectInput {
    pub name: String,
    pub work_dir: String,
}

/// Local project grouping (cwd → sidebar). Stateless file-backed store.
#[derive(Debug, Default, Clone)]
pub struct Projects;

impl Projects {
    pub fn new() -> Self {
        Self
    }

    pub fn list(&self) -> Vec<Project> {
        let mut projects: Vec<Project> = read_json_file(&get_projects_path(), Vec::new());
        projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        projects
    }

    pub fn get(&self, id: &str) -> Option<Project> {
        self.list().into_iter().find(|p| p.id == id)
    }

    pub fn create(&self, input: CreateProjectInput) -> Result<Project, String> {
        self.create_with_listed(input, true)
    }

    /// Hidden workspace for ungrouped chats (cwd only; not shown under 项目).
    pub fn create_default(&self) -> Result<Project, String> {
        let (dir, slug) = self.default_workspace_dir()?;
        self.create_with_listed(
            CreateProjectInput {
                name: slug,
                work_dir: dir.to_string_lossy().to_string(),
            },
            false,
        )
    }

    pub fn rename(&self, id: &str, name: &str) -> Result<Project, String> {
        let mut projects = self.list();
        let idx = projects
            .iter()
            .position(|p| p.id == id)
            .ok_or_else(|| "项目不存在".to_string())?;
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            projects[idx].name = trimmed.to_string();
        }
        projects[idx].updated_at = now_iso();
        let updated = projects[idx].clone();
        write_json_file(&get_projects_path(), &projects)?;
        Ok(updated)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut projects = self.list();
        if !projects.iter().any(|p| p.id == id) {
            return Err("项目不存在".to_string());
        }
        projects.retain(|p| p.id != id);
        write_json_file(&get_projects_path(), &projects)?;
        let dir = get_sessions_dir(id);
        if dir.exists() {
            let _ = fs::remove_dir_all(&dir);
        }
        Ok(())
    }

    pub fn touch(&self, id: &str) {
        let mut projects = self.list();
        if let Some(p) = projects.iter_mut().find(|p| p.id == id) {
            p.updated_at = now_iso();
            let _ = write_json_file(&get_projects_path(), &projects);
        }
    }

    /// Listed projects only: a project is a local cwd grouping of App Server threads.
    pub fn find_listed_id_for_cwd(&self, cwd: &str) -> Option<String> {
        if cwd.trim().is_empty() {
            return None;
        }
        let needle = Self::normalize_path(cwd);
        self.list()
            .into_iter()
            .filter(|p| p.listed)
            .find(|p| Self::normalize_path(&p.work_dir) == needle)
            .map(|p| p.id)
    }

    /// Documents/Codex/YYYY-MM-DD/<slug> — matches Codex Desktop default workspace layout.
    pub fn default_workspace_dir(&self) -> Result<(PathBuf, String), String> {
        let docs = dirs::document_dir().ok_or_else(|| "无法定位 Documents 目录".to_string())?;
        let date = Local::now().format("%Y-%m-%d").to_string();
        let mut slug = Self::workspace_slug();
        let mut dir = docs.join("Codex").join(&date).join(&slug);
        if dir.exists() {
            slug = Self::workspace_slug();
            dir = docs.join("Codex").join(&date).join(&slug);
        }
        fs::create_dir_all(&dir).map_err(|e| format!("创建工作目录失败：{e}"))?;
        Ok((dir, slug))
    }

    fn create_with_listed(&self, input: CreateProjectInput, listed: bool) -> Result<Project, String> {
        let mut projects = self.list();
        let now = now_iso();
        let project = Project {
            id: Uuid::new_v4().to_string(),
            name: {
                let n = input.name.trim();
                if n.is_empty() {
                    "未命名项目".into()
                } else {
                    n.to_string()
                }
            },
            work_dir: input.work_dir,
            listed,
            created_at: now.clone(),
            updated_at: now,
        };
        projects.insert(0, project.clone());
        write_json_file(&get_projects_path(), &projects)?;
        Ok(project)
    }

    fn workspace_slug() -> String {
        let raw = Uuid::new_v4().simple().to_string();
        format!("{}-{}", &raw[0..2], &raw[2..3])
    }

    fn normalize_path(raw: &str) -> String {
        let path = PathBuf::from(raw.trim());
        let resolved = path.canonicalize().unwrap_or(path);
        let s = resolved.to_string_lossy().replace('\\', "/");
        let trimmed = s.trim_end_matches('/');
        if cfg!(windows) || cfg!(target_os = "macos") {
            trimmed.to_lowercase()
        } else {
            trimmed.to_string()
        }
    }
}

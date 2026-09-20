use super::RpcClient;
use crate::runtime::CodexRuntime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillToolDependency {
    #[serde(rename = "type")]
    pub kind: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub path: String,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short_description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brand_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_small: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_large: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dependencies: Vec<SkillToolDependency>,
}

pub struct Skills {
    runtime: Arc<CodexRuntime>,
}

impl Skills {
    pub fn new(runtime: Arc<CodexRuntime>) -> Self {
        Self { runtime }
    }

    pub async fn list(
        &self,
        cwds: Option<Vec<String>>,
        force_reload: bool,
    ) -> Result<Vec<SkillInfo>, String> {
        let client = self.runtime.connected_client().await?;
        Self::list_client(&client, cwds, force_reload).await
    }

    pub async fn set_enabled(
        &self,
        enabled: bool,
        name: Option<String>,
        path: Option<String>,
    ) -> Result<bool, String> {
        let client = self.runtime.connected_client().await?;
        Self::set_enabled_client(&client, enabled, name, path).await
    }

    async fn list_client(
        client: &RpcClient,
        cwds: Option<Vec<String>>,
        force_reload: bool,
    ) -> Result<Vec<SkillInfo>, String> {
        let result = client.skills_list(cwds, force_reload).await?;
        Ok(Self::parse_skills(&result))
    }

    async fn set_enabled_client(
        client: &RpcClient,
        enabled: bool,
        name: Option<String>,
        path: Option<String>,
    ) -> Result<bool, String> {
        let path = path.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let name = name.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let (name, path) = if path.is_some() {
            (None, path)
        } else if name.is_some() {
            (name, None)
        } else {
            return Err("需要 skill 的 name 或 path".into());
        };
        let result = client.skills_config_write(enabled, name, path).await?;
        Ok(result
            .get("effectiveEnabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(enabled))
    }

    fn parse_skills(result: &Value) -> Vec<SkillInfo> {
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        let entries = result
            .get("data")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for entry in entries {
            let cwd = entry
                .get("cwd")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let skills = entry
                .get("skills")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            for skill in skills {
                let path = skill
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let name = skill
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let key = if !path.is_empty() {
                    path.clone()
                } else {
                    name.clone()
                };
                if key.is_empty() || !seen.insert(key) {
                    continue;
                }
                let interface = skill.get("interface");
                out.push(SkillInfo {
                    name,
                    description: skill
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    enabled: skill
                        .get("enabled")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true),
                    path,
                    scope: skill
                        .get("scope")
                        .and_then(|v| v.as_str())
                        .unwrap_or("user")
                        .to_string(),
                    cwd: cwd.clone(),
                    display_name: opt_str(interface, "displayName"),
                    short_description: opt_str(interface, "shortDescription").or_else(|| {
                        skill
                            .get("shortDescription")
                            .and_then(|v| v.as_str())
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string())
                    }),
                    brand_color: opt_str(interface, "brandColor"),
                    icon_small: opt_str(interface, "iconSmall"),
                    icon_large: opt_str(interface, "iconLarge"),
                    default_prompt: opt_str(interface, "defaultPrompt"),
                    dependencies: parse_dependencies(&skill),
                });
            }
        }
        out.sort_by(|a, b| {
            a.name
                .to_ascii_lowercase()
                .cmp(&b.name.to_ascii_lowercase())
        });
        out
    }
}

fn opt_str(obj: Option<&Value>, key: &str) -> Option<String> {
    obj.and_then(|v| v.get(key))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn parse_dependencies(skill: &Value) -> Vec<SkillToolDependency> {
    skill
        .pointer("/dependencies/tools")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    let value = t.get("value").and_then(|v| v.as_str())?.to_string();
                    Some(SkillToolDependency {
                        kind: t
                            .get("type")
                            .and_then(|v| v.as_str())
                            .unwrap_or("tool")
                            .to_string(),
                        value,
                        command: opt_str(Some(t), "command"),
                        description: opt_str(Some(t), "description"),
                        transport: opt_str(Some(t), "transport"),
                        url: opt_str(Some(t), "url"),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

use super::RpcClient;
use crate::host::cron::{
    CronJob, CronJobSource, CronOrigin, CronRepeat, CronService, UpsertCronJobInput,
};
use crate::runtime::CodexRuntime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub developer_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brand_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo_dark: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo_url_dark: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub website_url: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub screenshot_urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub screenshots: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub default_prompts: Vec<String>,
    pub marketplace_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marketplace_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_marketplace_name: Option<String>,
}

pub struct Plugins {
    runtime: Arc<CodexRuntime>,
}

impl Plugins {
    pub fn new(runtime: Arc<CodexRuntime>) -> Self {
        Self { runtime }
    }

    pub async fn list(&self, cwds: Option<Vec<String>>) -> Result<Vec<PluginInfo>, String> {
        let client = self.runtime.connected_client().await?;
        Self::list_client(&client, cwds).await
    }

    pub async fn install(
        &self,
        plugin_name: String,
        marketplace_path: Option<String>,
        remote_marketplace_name: Option<String>,
    ) -> Result<(), String> {
        let client = self.runtime.connected_client().await?;
        Self::install_client(
            &client,
            plugin_name,
            marketplace_path,
            remote_marketplace_name,
        )
        .await
    }

    pub async fn uninstall(&self, plugin_id: String) -> Result<(), String> {
        let client = self.runtime.connected_client().await?;
        Self::uninstall_client(&client, plugin_id).await
    }

    pub async fn read(
        &self,
        plugin_name: String,
        marketplace_path: Option<String>,
        remote_marketplace_name: Option<String>,
    ) -> Result<Value, String> {
        let client = self.runtime.connected_client().await?;
        let name = plugin_name.trim();
        if name.is_empty() {
            return Err("pluginName 不能为空".into());
        }
        client
            .plugin_read(
                name,
                marketplace_path
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty()),
                remote_marketplace_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty()),
            )
            .await
    }

    pub async fn add_scheduled_task(
        &self,
        cron: &CronService,
        plugin_name: String,
        marketplace_path: Option<String>,
        remote_marketplace_name: Option<String>,
        task_key: String,
        project_id: Option<String>,
    ) -> Result<CronJob, String> {
        let detail = self
            .read(
                plugin_name.clone(),
                marketplace_path.clone(),
                remote_marketplace_name.clone(),
            )
            .await?;
        let tasks = detail
            .pointer("/plugin/scheduledTasks")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let key = task_key.trim();
        if key.is_empty() {
            return Err("taskKey 不能为空".into());
        }
        let task = tasks
            .iter()
            .find(|t| t.get("key").and_then(|v| v.as_str()) == Some(key))
            .ok_or_else(|| format!("插件中找不到 scheduledTask：{key}"))?;
        let name = task
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(key)
            .to_string();
        let prompt = task
            .get("prompt")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "scheduledTask 缺少 prompt".to_string())?
            .to_string();
        let schedule = task
            .get("schedule")
            .ok_or_else(|| "scheduledTask 缺少 schedule".to_string())?;
        let cron_expr = CronService::plugin_schedule_to_cron(schedule)?;
        let plugin_id = detail
            .pointer("/plugin/summary/id")
            .and_then(|v| v.as_str())
            .unwrap_or(plugin_name.trim())
            .to_string();

        cron.upsert_job(UpsertCronJobInput {
            id: None,
            name,
            prompt,
            cron_expr,
            schedule_preset: None,
            time: None,
            interval_hours: None,
            days: None,
            once_at: None,
            enabled: true,
            project_id: project_id.filter(|s| !s.trim().is_empty()),
            thread_id: None,
            origin: CronOrigin::NewInProject,
            repeat: Some(CronRepeat::ReuseFirst),
            model: None,
            sandbox: None,
            approval_policy: Some("never".into()),
            timeout_mins: Some(30),
            source: Some(CronJobSource {
                kind: "plugin".into(),
                plugin_id: Some(plugin_id),
                plugin_task_key: Some(key.to_string()),
            }),
        })
    }

    async fn list_client(
        client: &RpcClient,
        cwds: Option<Vec<String>>,
    ) -> Result<Vec<PluginInfo>, String> {
        let (available, installed) = tokio::try_join!(
            client.plugin_list(cwds.clone()),
            client.plugin_installed(cwds),
        )?;
        Ok(Self::merge_plugins(&available, &installed))
    }

    async fn install_client(
        client: &RpcClient,
        plugin_name: String,
        marketplace_path: Option<String>,
        remote_marketplace_name: Option<String>,
    ) -> Result<(), String> {
        let name = plugin_name.trim();
        if name.is_empty() {
            return Err("pluginName 不能为空".into());
        }
        client
            .plugin_install(
                name,
                marketplace_path
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty()),
                remote_marketplace_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty()),
            )
            .await?;
        Ok(())
    }

    async fn uninstall_client(client: &RpcClient, plugin_id: String) -> Result<(), String> {
        Self::uninstall_plugin(client, plugin_id).await
    }

    pub async fn uninstall_plugin(client: &RpcClient, plugin_id: String) -> Result<(), String> {
        let id = plugin_id.trim();
        if id.is_empty() {
            return Err("pluginId 不能为空".into());
        }
        client.plugin_uninstall(id).await?;
        Ok(())
    }

    fn merge_plugins(available: &Value, installed: &Value) -> Vec<PluginInfo> {
        let mut by_id: HashMap<String, PluginInfo> = HashMap::new();
        for plugin in Self::flatten_plugins(available) {
            by_id.insert(plugin.id.clone(), plugin);
        }
        for plugin in Self::flatten_plugins(installed) {
            by_id
                .entry(plugin.id.clone())
                .and_modify(|existing| {
                    existing.installed = true;
                    existing.enabled = plugin.enabled;
                    Self::fill_missing(existing, &plugin);
                })
                .or_insert(PluginInfo {
                    installed: true,
                    ..plugin
                });
        }
        let mut out: Vec<_> = by_id.into_values().collect();
        out.sort_by(|a, b| match (b.installed, a.installed) {
            (true, false) => std::cmp::Ordering::Greater,
            (false, true) => std::cmp::Ordering::Less,
            _ => a
                .name
                .to_ascii_lowercase()
                .cmp(&b.name.to_ascii_lowercase()),
        });
        out
    }

    fn fill_missing(dst: &mut PluginInfo, src: &PluginInfo) {
        if dst.version.is_none() {
            dst.version = src.version.clone();
        }
        if dst.display_name.is_none() {
            dst.display_name = src.display_name.clone();
        }
        if dst.description.is_none() {
            dst.description = src.description.clone();
        }
        if dst.long_description.is_none() {
            dst.long_description = src.long_description.clone();
        }
        if dst.category.is_none() {
            dst.category = src.category.clone();
        }
        if dst.developer_name.is_none() {
            dst.developer_name = src.developer_name.clone();
        }
        if dst.brand_color.is_none() {
            dst.brand_color = src.brand_color.clone();
        }
        if dst.logo.is_none() {
            dst.logo = src.logo.clone();
        }
        if dst.logo_dark.is_none() {
            dst.logo_dark = src.logo_dark.clone();
        }
        if dst.logo_url.is_none() {
            dst.logo_url = src.logo_url.clone();
        }
        if dst.logo_url_dark.is_none() {
            dst.logo_url_dark = src.logo_url_dark.clone();
        }
        if dst.website_url.is_none() {
            dst.website_url = src.website_url.clone();
        }
        if dst.capabilities.is_empty() {
            dst.capabilities = src.capabilities.clone();
        }
        if dst.keywords.is_empty() {
            dst.keywords = src.keywords.clone();
        }
        if dst.screenshot_urls.is_empty() {
            dst.screenshot_urls = src.screenshot_urls.clone();
        }
        if dst.screenshots.is_empty() {
            dst.screenshots = src.screenshots.clone();
        }
        if dst.default_prompts.is_empty() {
            dst.default_prompts = src.default_prompts.clone();
        }
    }

    fn flatten_plugins(result: &Value) -> Vec<PluginInfo> {
        let mut out = Vec::new();
        let marketplaces = result
            .get("marketplaces")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for marketplace in marketplaces {
            let marketplace_name = marketplace
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let marketplace_path = marketplace
                .get("path")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let plugins = marketplace
                .get("plugins")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            for plugin in plugins {
                let id = plugin
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let name = plugin
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if id.is_empty() && name.is_empty() {
                    continue;
                }
                let interface = plugin.get("interface");
                let remote_marketplace_name =
                    if marketplace_path.is_none() && !marketplace_name.is_empty() {
                        Some(marketplace_name.clone())
                    } else {
                        None
                    };
                out.push(PluginInfo {
                    id: if id.is_empty() { name.clone() } else { id },
                    name,
                    enabled: plugin
                        .get("enabled")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true),
                    installed: plugin
                        .get("installed")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                    version: plugin
                        .get("localVersion")
                        .and_then(|v| v.as_str())
                        .or_else(|| plugin.get("version").and_then(|v| v.as_str()))
                        .map(|s| s.to_string()),
                    display_name: opt_str(interface, "displayName"),
                    description: opt_str(interface, "shortDescription"),
                    long_description: opt_str(interface, "longDescription"),
                    category: opt_str(interface, "category"),
                    developer_name: opt_str(interface, "developerName"),
                    brand_color: opt_str(interface, "brandColor"),
                    logo: opt_str(interface, "logo"),
                    logo_dark: opt_str(interface, "logoDark"),
                    logo_url: opt_str(interface, "logoUrl"),
                    logo_url_dark: opt_str(interface, "logoUrlDark"),
                    website_url: opt_str(interface, "websiteUrl"),
                    capabilities: string_list(interface, "capabilities"),
                    keywords: string_list(Some(&plugin), "keywords")
                        .into_iter()
                        .chain(string_list(interface, "keywords"))
                        .collect(),
                    screenshot_urls: string_list(interface, "screenshotUrls"),
                    screenshots: string_list(interface, "screenshots"),
                    default_prompts: string_list(interface, "defaultPrompt"),
                    marketplace_name: marketplace_name.clone(),
                    marketplace_path: marketplace_path.clone(),
                    remote_marketplace_name,
                });
            }
        }
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

fn string_list(obj: Option<&Value>, key: &str) -> Vec<String> {
    obj.and_then(|v| v.get(key))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default()
}

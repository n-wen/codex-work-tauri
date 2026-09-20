use super::store::{get_settings_path, read_json_file, write_json_file};
use crate::types::ResultOrError;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    pub label: String,
    /// API model id passed to thread/turn.
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEntry {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub api_key: String,
    #[serde(default)]
    pub models: Vec<ModelEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub providers: Vec<ProviderEntry>,
    pub active_provider_id: String,
    /// Optional absolute path to a Codex binary. Empty = download/use the pinned version.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_bin: Option<String>,
    /// Preferred editor command (`code`, `code.cmd`, absolute path, …).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editor_command: Option<String>,
}

impl<'de> Deserialize<'de> for AppSettings {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Ok(Self::from_value(value))
    }
}

impl AppSettings {
    /// Migrate legacy `{ baseUrl, apiKey, model }` or accept `providers` + `activeProviderId`.
    pub fn from_value(value: Value) -> Self {
        let codex_bin = value
            .get("codexBin")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let editor_command = value
            .get("editorCommand")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        if let Some(arr) = value.get("providers").and_then(|v| v.as_array()) {
            if !arr.is_empty() {
                let providers: Vec<ProviderEntry> = arr
                    .iter()
                    .filter_map(|p| serde_json::from_value(p.clone()).ok())
                    .map(Self::normalize_provider)
                    .filter(|p| !p.base_url.is_empty())
                    .collect();
                if !providers.is_empty() {
                    let active = value
                        .get("activeProviderId")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    let active_provider_id = if providers.iter().any(|p| p.id == active) {
                        active
                    } else {
                        providers[0].id.clone()
                    };
                    return Self {
                        providers,
                        active_provider_id,
                        codex_bin,
                        editor_command,
                    };
                }
            }
        }

        // Legacy flat shape.
        let base_url = value
            .get("baseUrl")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .trim_end_matches('/')
            .to_string();
        let api_key = value
            .get("apiKey")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let model = value
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let models = if model.is_empty() {
            Vec::new()
        } else {
            vec![ModelEntry {
                id: "default".into(),
                label: model.clone(),
                model: model.clone(),
            }]
        };
        let provider = ProviderEntry {
            id: "default".into(),
            label: "默认".into(),
            base_url,
            api_key,
            models,
        };
        Self {
            providers: vec![provider],
            active_provider_id: "default".into(),
            codex_bin,
            editor_command,
        }
    }

    /// Default editor command when settings / args omit one.
    pub fn default_editor_command() -> &'static str {
        if cfg!(windows) {
            "code.cmd"
        } else {
            "code"
        }
    }

    pub fn resolved_editor_command(&self) -> String {
        self.editor_command
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| Self::default_editor_command().to_string())
    }

    fn normalize_provider(mut p: ProviderEntry) -> ProviderEntry {
        p.id = p.id.trim().to_string();
        if p.id.is_empty() {
            p.id = "default".into();
        }
        p.label = {
            let t = p.label.trim().to_string();
            if t.is_empty() {
                p.id.clone()
            } else {
                t
            }
        };
        p.base_url = p.base_url.trim().trim_end_matches('/').to_string();
        p.api_key = p.api_key.trim().to_string();
        p.models = p
            .models
            .into_iter()
            .filter_map(|m| {
                let model = m.model.trim().to_string();
                if model.is_empty() {
                    return None;
                }
                let id = {
                    let t = m.id.trim().to_string();
                    if t.is_empty() {
                        model.clone()
                    } else {
                        t
                    }
                };
                let label = {
                    let t = m.label.trim().to_string();
                    if t.is_empty() {
                        model.clone()
                    } else {
                        t
                    }
                };
                Some(ModelEntry { id, label, model })
            })
            .collect();
        p
    }

    pub fn active(&self) -> Option<&ProviderEntry> {
        self.providers
            .iter()
            .find(|p| p.id == self.active_provider_id)
            .or_else(|| self.providers.first())
    }

    pub fn base_url(&self) -> &str {
        self.active().map(|p| p.base_url.as_str()).unwrap_or("")
    }

    pub fn api_key(&self) -> &str {
        self.active().map(|p| p.api_key.as_str()).unwrap_or("")
    }

    /// Default model id for new threads (first model of active provider).
    pub fn default_model(&self) -> &str {
        self.active()
            .and_then(|p| p.models.first())
            .map(|m| m.model.as_str())
            .unwrap_or("")
    }

    pub fn connection_fingerprint(&self) -> String {
        format!("{}|{}", self.base_url(), self.api_key())
    }

    pub fn is_configured(&self) -> bool {
        !self.base_url().is_empty()
            && !self.api_key().is_empty()
            && !self.default_model().is_empty()
    }

    fn cleaned(self) -> Self {
        let providers: Vec<ProviderEntry> = self
            .providers
            .into_iter()
            .map(Self::normalize_provider)
            .filter(|p| !p.base_url.is_empty())
            .collect();
        let active_provider_id = if providers.iter().any(|p| p.id == self.active_provider_id) {
            self.active_provider_id
        } else {
            providers
                .first()
                .map(|p| p.id.clone())
                .unwrap_or_default()
        };
        Self {
            providers,
            active_provider_id,
            codex_bin: self
                .codex_bin
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            editor_command: self
                .editor_command
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
        }
    }
}

/// Local app settings (API endpoint, key, models). Stateless: each call reads/writes disk.
#[derive(Debug, Default, Clone)]
pub struct Settings;

impl Settings {
    pub fn new() -> Self {
        Self
    }

    pub fn load(&self) -> Option<AppSettings> {
        let data: Option<Value> = read_json_file(&get_settings_path(), None);
        match data {
            Some(v) => {
                let s = AppSettings::from_value(v);
                if s.is_configured() {
                    Some(s)
                } else {
                    None
                }
            }
            None => None,
        }
    }

    pub fn save(&self, settings: &AppSettings) -> Result<(), String> {
        let cleaned = settings.clone().cleaned();
        write_json_file(&get_settings_path(), &cleaned)
    }

    pub fn mask_api_key(&self, api_key: &str) -> String {
        if api_key.is_empty() {
            return String::new();
        }
        if api_key.len() <= 8 {
            return "••••••••".into();
        }
        let prefix = &api_key[..4];
        let suffix = &api_key[api_key.len() - 4..];
        let mid = "•".repeat((api_key.len() - 8).min(24));
        format!("{prefix}{mid}{suffix}")
    }

    pub async fn validate(&self, settings: &AppSettings) -> ResultOrError {
        let cleaned = settings.clone().cleaned();
        let base_url = cleaned.base_url();
        let api_key = cleaned.api_key();
        let model = cleaned.default_model();

        if cleaned.providers.is_empty() {
            return ResultOrError::err("请至少添加一套 Provider");
        }
        if base_url.is_empty() {
            return ResultOrError::err("请填写当前 Provider 的 baseUrl");
        }
        if api_key.is_empty() {
            return ResultOrError::err("请填写当前 Provider 的 apiKey");
        }
        if model.is_empty() {
            return ResultOrError::err("请为当前 Provider 至少添加一条模型");
        }
        for p in &cleaned.providers {
            if p.models.is_empty() {
                return ResultOrError::err(format!("Provider「{}」至少需要一条模型", p.label));
            }
        }

        if let Err(e) =
            crate::app_server::managed::CodexBin::ensure_codex_bin(cleaned.codex_bin.as_deref())
        {
            return ResultOrError::err(e);
        }

        let parsed = match reqwest::Url::parse(base_url) {
            Ok(u) => u,
            Err(_) => {
                return ResultOrError::err("baseUrl 不是合法 URL，例如 https://api.openai.com/v1")
            }
        };
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            return ResultOrError::err("baseUrl 仅支持 http 或 https 协议");
        }

        let endpoint = format!("{base_url}/models");
        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
        {
            Ok(c) => c,
            Err(e) => return ResultOrError::err(format!("无法创建 HTTP 客户端：{e}")),
        };

        match client
            .get(&endpoint)
            .header("Authorization", format!("Bearer {api_key}"))
            .send()
            .await
        {
            Ok(resp) => {
                let code = resp.status().as_u16();
                if code == 401 || code == 403 {
                    let detail = resp.text().await.unwrap_or_default();
                    return ResultOrError::err(format!(
                        "鉴权失败（{code}）：请检查 apiKey。{}",
                        detail.chars().take(200).collect::<String>()
                    ));
                }
                ResultOrError::ok()
            }
            Err(e) => {
                if e.is_timeout() {
                    ResultOrError::err("连接超时：请检查 baseUrl 是否可达")
                } else {
                    eprintln!("[settings] provider probe failed: {e}");
                    ResultOrError::ok()
                }
            }
        }
    }
}

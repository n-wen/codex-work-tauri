use super::RpcClient;
use crate::runtime::CodexRuntime;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

/// Agent sandbox + approval defaults from App Server `config.toml`
/// (`sandbox_mode` / `approval_policy`). Matches Codex Desktop permissions control.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissions {
    /// `read-only` | `workspace-write` | `danger-full-access`
    pub sandbox: String,
    /// `untrusted` | `on-request` | `never`
    pub approval_policy: String,
}

impl AgentPermissions {
    pub fn default_auto() -> Self {
        Self {
            sandbox: "workspace-write".into(),
            approval_policy: "on-request".into(),
        }
    }

    pub fn normalize(self) -> Self {
        let sandbox = match self.sandbox.as_str() {
            "read-only" | "workspace-write" | "danger-full-access" => self.sandbox,
            _ => "workspace-write".into(),
        };
        let approval_policy = match self.approval_policy.as_str() {
            "untrusted" | "on-request" | "never" => self.approval_policy,
            _ => "on-request".into(),
        };
        Self {
            sandbox,
            approval_policy,
        }
    }
}

pub struct Permissions {
    runtime: Arc<CodexRuntime>,
}

impl Permissions {
    pub fn new(runtime: Arc<CodexRuntime>) -> Self {
        Self { runtime }
    }

    pub async fn read(&self) -> Result<AgentPermissions, String> {
        let client = self.runtime.connected_client().await?;
        Self::read_client(&client).await
    }

    pub async fn write(&self, permissions: AgentPermissions) -> Result<AgentPermissions, String> {
        let client = self.runtime.connected_client().await?;
        Self::write_client(&client, permissions).await
    }

    pub async fn read_client(client: &RpcClient) -> Result<AgentPermissions, String> {
        let result = client.config_read()            .await?;
        Ok(Self::permissions_from_config(&result))
    }

    async fn write_client(
        client: &RpcClient,
        permissions: AgentPermissions,
    ) -> Result<AgentPermissions, String> {
        let permissions = permissions.normalize();
        client
            .config_batch_write(vec![
                (
                    "sandbox_mode".into(),
                    json!(permissions.sandbox),
                    "replace",
                ),
                (
                    "approval_policy".into(),
                    json!(permissions.approval_policy),
                    "replace",
                ),
            ])
            .await?;
        Ok(permissions)
    }

    fn permissions_from_config(result: &Value) -> AgentPermissions {
        let config = result.get("config").unwrap_or(&Value::Null);
        let sandbox = config
            .get("sandbox_mode")
            .and_then(|v| v.as_str())
            .unwrap_or("workspace-write")
            .to_string();
        let approval_policy = match config.get("approval_policy") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Object(_)) => "on-request".into(),
            _ => "on-request".into(),
        };
        AgentPermissions {
            sandbox,
            approval_policy,
        }
        .normalize()
    }
}

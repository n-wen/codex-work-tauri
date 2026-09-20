use crate::app_server::generated::config_read_params::ConfigReadParams;
use crate::app_server::generated::config_value_write_params::{
    ConfigValueWriteParams, MergeStrategy,
};
use crate::app_server::generated::initialize_params::{
    ClientInfo, InitializeCapabilities, InitializeParams,
};
use crate::app_server::generated::thread_list_params::{
    SortDirection, ThreadListParams, ThreadSortKey,
};
use crate::app_server::generated::thread_read_params::ThreadReadParams;
use crate::app_server::generated::thread_resume_params::{
    AskForApproval as ResumeAskForApproval, AskForApprovalLiteral as ResumeAskForApprovalLiteral,
    DynamicToolSpec as ResumeDynamicToolSpec, SandboxMode as ResumeSandboxMode, ThreadResumeParams,
};
use crate::app_server::generated::thread_set_name_params::ThreadSetNameParams;
use crate::app_server::generated::thread_start_params::{
    AskForApproval, AskForApprovalLiteral, DynamicToolSpec, SandboxMode, ThreadStartParams,
};
use crate::app_server::generated::turn_interrupt_params::TurnInterruptParams;
use crate::app_server::generated::turn_start_params::{
    AskForApproval as TurnAskForApproval, AskForApprovalLiteral as TurnAskForApprovalLiteral,
    SandboxPolicy, TurnStartParams, UserInput,
};
use crate::app_server::generated::{ClientNotificationMethod, ClientRequestMethod};
use crate::app_server::managed::CodexBin;
use crate::host::settings::AppSettings;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

#[derive(Debug)]
pub enum RpcError {
    TransportClosed,
    Server {
        code: i64,
        message: String,
        #[allow(dead_code)]
        data: Option<Value>,
    },
    Other(String),
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TransportClosed => write!(f, "App Server 连接已断开"),
            Self::Server { code, message, .. } => write!(f, "App Server 错误（{code}）：{message}"),
            Self::Other(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for RpcError {}

type PendingMap = HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>;

#[derive(Debug, Clone)]
pub enum Incoming {
    /// Server → client notification (no id)
    Notification { method: String, params: Value },
    /// Server → client request (has id + method) — e.g. approvals
    ServerRequest {
        id: Value,
        method: String,
        params: Value,
    },
}

pub struct RpcClient {
    next_id: AtomicU64,
    alive: Arc<AtomicBool>,
    write_tx: mpsc::UnboundedSender<String>,
    pending: Arc<tokio::sync::Mutex<PendingMap>>,
    _child: Child,
    _writer: JoinHandle<()>,
    _reader: JoinHandle<()>,
    #[allow(dead_code)]
    pub codex_bin: String,
}

impl RpcClient {
    /// Spawn Codex `app-server` over stdio, then send `initialize` / `initialized`.
    pub async fn connect(
        settings: &AppSettings,
    ) -> Result<(Self, mpsc::UnboundedReceiver<Incoming>), String> {
        let bin = CodexBin::ensure_codex_bin(settings.codex_bin.as_deref())?;
        let bin_str = bin.to_string_lossy().to_string();

        let mut args = vec!["app-server".into(), "--listen".into(), "stdio://".into()];

        let provider_name = "codex-work";
        let base_url = settings.base_url().trim().trim_end_matches('/');
        let model = settings.default_model().trim();
        let provider_label = settings
            .active()
            .map(|p| p.label.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("Codex Work");

        if !model.is_empty() {
            args.push("-c".into());
            args.push(format!("model={model:?}"));
        }
        args.push("-c".into());
        args.push(format!("model_provider={provider_name:?}"));

        let provider_toml = format!(
            r#"model_providers.{provider_name}={{name={provider_label:?}, base_url={base_url:?}, env_key="CODEX_WORK_API_KEY", wire_api="responses", requires_openai_auth=false}}"#
        );
        args.push("-c".into());
        args.push(provider_toml);

        let mut env = HashMap::new();
        let api_key = settings.api_key().trim();
        if !api_key.is_empty() {
            env.insert("CODEX_WORK_API_KEY".into(), api_key.to_string());
            env.insert("OPENAI_API_KEY".into(), api_key.to_string());
        }

        eprintln!("[codex] spawning app-server: {bin_str}");
        let (client, incoming_rx) = Self::spawn(&bin_str, &args, env).await?;

        eprintln!("[codex-rpc] → initialize");
        let init_params = InitializeParams {
            client_info: ClientInfo {
                name: "codex_work".into(),
                title: Some("Codex Work".into()),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            capabilities: Some(InitializeCapabilities {
                experimental_api: Some(true),
                mcp_server_openai_form_elicitation: None,
                opt_out_notification_methods: None,
                request_attestation: None,
            }),
        };
        let init_result = client
            .request_typed(ClientRequestMethod::Initialize, &init_params)
            .await
            .map_err(|e| e.to_string())?;
        eprintln!("[codex-rpc] ← initialize ok: {init_result}");
        client
            .notify_typed(ClientNotificationMethod::Initialized, &json!({}))
            .map_err(|e| e.to_string())?;
        eprintln!("[codex-rpc] → initialized (notify)");

        Ok((client, incoming_rx))
    }

    async fn spawn(
        bin: &str,
        args: &[String],
        env: HashMap<String, String>,
    ) -> Result<(Self, mpsc::UnboundedReceiver<Incoming>), String> {
        let mut cmd = Command::new(bin);
        cmd.args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // Windows: hide the console window that console-subsystem binaries (codex.exe) open.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        for (k, v) in &env {
            cmd.env(k, v);
        }

        let mut child = cmd.spawn().map_err(|e| {
            format!("无法启动 Codex App Server（{bin}）：{e}。请确认已安装 Codex CLI，或在设置中指定 codex 路径。")
        })?;

        let stdin = child.stdin.take().ok_or_else(|| "缺少 stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "缺少 stdout".to_string())?;
        let stderr = child.stderr.take();

        if let Some(stderr) = stderr {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("[codex-app-server] {line}");
                }
            });
        }

        let (write_tx, write_rx) = mpsc::unbounded_channel::<String>();
        let (incoming_tx, incoming_rx) = mpsc::unbounded_channel::<Incoming>();
        let pending: Arc<tokio::sync::Mutex<PendingMap>> =
            Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));

        let writer = Self::spawn_writer(stdin, write_rx, pending.clone(), alive.clone());
        let reader = Self::spawn_reader(stdout, pending.clone(), incoming_tx, alive.clone());

        Ok((
            Self {
                next_id: AtomicU64::new(1),
                alive: alive.clone(),
                write_tx,
                pending,
                _child: child,
                _writer: writer,
                _reader: reader,
                codex_bin: bin.to_string(),
            },
            incoming_rx,
        ))
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    pub async fn request_typed<M, P>(&self, method: M, params: &P) -> Result<Value, RpcError>
    where
        M: AsRef<str>,
        P: serde::Serialize,
    {
        let value = serde_json::to_value(params).map_err(|e| RpcError::Other(e.to_string()))?;
        self.request(method.as_ref(), value).await
    }

    pub fn notify_typed<M, P>(&self, method: M, params: &P) -> Result<(), RpcError>
    where
        M: AsRef<str>,
        P: serde::Serialize,
    {
        let value = serde_json::to_value(params).map_err(|e| RpcError::Other(e.to_string()))?;
        self.notify(method.as_ref(), value)
    }

    pub fn respond_typed<T: serde::Serialize>(
        &self,
        id: Value,
        result: &T,
    ) -> Result<(), RpcError> {
        let value = serde_json::to_value(result).map_err(|e| RpcError::Other(e.to_string()))?;
        self.respond(id, value)
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err(RpcError::TransportClosed);
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let msg = json!({
            "id": id,
            "method": method,
            "params": params,
        });
        let line = serde_json::to_string(&msg).map_err(|e| RpcError::Other(e.to_string()))?;
        if self.write_tx.send(line).is_err() {
            self.pending.lock().await.remove(&id);
            return Err(RpcError::TransportClosed);
        }

        match rx.await {
            Ok(result) => result,
            Err(_) => Err(RpcError::TransportClosed),
        }
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<(), RpcError> {
        let msg = json!({
            "method": method,
            "params": params,
        });
        let line = serde_json::to_string(&msg).map_err(|e| RpcError::Other(e.to_string()))?;
        self.write_tx
            .send(line)
            .map_err(|_| RpcError::TransportClosed)
    }

    pub fn respond(&self, id: Value, result: Value) -> Result<(), RpcError> {
        let msg = json!({
            "id": id,
            "result": result,
        });
        let line = serde_json::to_string(&msg).map_err(|e| RpcError::Other(e.to_string()))?;
        self.write_tx
            .send(line)
            .map_err(|_| RpcError::TransportClosed)
    }

    pub fn respond_error(&self, id: Value, code: i64, message: &str) -> Result<(), RpcError> {
        let msg = json!({
            "id": id,
            "error": { "code": code, "message": message },
        });
        let line = serde_json::to_string(&msg).map_err(|e| RpcError::Other(e.to_string()))?;
        self.write_tx
            .send(line)
            .map_err(|_| RpcError::TransportClosed)
    }

    pub async fn config_read(&self) -> Result<Value, String> {
        eprintln!("[codex-rpc] → config/read");
        let result = self
            .request_typed(
                ClientRequestMethod::ConfigRead,
                &ConfigReadParams::default(),
            )
            .await
            .map_err(|e| e.to_string())?;
        eprintln!("[codex-rpc] ← config/read ok");
        Ok(result)
    }

    pub async fn config_value_write(
        &self,
        key_path: &str,
        value: Value,
    ) -> Result<Value, String> {
        self.config_value_write_ex(key_path, value, false).await
    }

    pub async fn config_value_write_ex(
        &self,
        key_path: &str,
        value: Value,
        upsert: bool,
    ) -> Result<Value, String> {
        eprintln!("[codex-rpc] → config/value/write keyPath={key_path} upsert={upsert}");
        let params = ConfigValueWriteParams {
            expected_version: None,
            file_path: None,
            key_path: key_path.to_string(),
            merge_strategy: if upsert {
                MergeStrategy::Upsert
            } else {
                MergeStrategy::Replace
            },
            value,
        };
        let result = self
            .request_typed(ClientRequestMethod::ConfigValueWrite, &params)
            .await
            .map_err(|e| e.to_string())?;
        eprintln!("[codex-rpc] ← config/value/write ok keyPath={key_path}");
        Ok(result)
    }

    pub async fn config_batch_write(
        &self,
        edits: Vec<(String, Value, &str)>,
    ) -> Result<Value, String> {
        let edits_json: Vec<Value> = edits
            .into_iter()
            .map(|(key_path, value, merge)| {
                json!({
                    "keyPath": key_path,
                    "value": value,
                    "mergeStrategy": merge,
                })
            })
            .collect();
        eprintln!(
            "[codex-rpc] → config/batchWrite edits={}",
            edits_json.len()
        );
        let result = self
            .request(
                ClientRequestMethod::ConfigBatchWrite.as_str(),
                json!({ "edits": edits_json, "reloadUserConfig": true }),
            )
            .await
            .map_err(|e| e.to_string())?;
        eprintln!("[codex-rpc] ← config/batchWrite ok");
        Ok(result)
    }

    pub async fn permission_profile_list(
        &self,
        cwd: Option<&str>,
    ) -> Result<Value, String> {
        eprintln!("[codex-rpc] → permissionProfile/list cwd={cwd:?}");
        let mut params = json!({});
        if let Some(c) = cwd.map(str::trim).filter(|s| !s.is_empty()) {
            params["cwd"] = json!(c);
        }
        let result = self
            .request(
                ClientRequestMethod::PermissionProfileList.as_str(),
                params,
            )
            .await
            .map_err(|e| e.to_string())?;
        eprintln!("[codex-rpc] ← permissionProfile/list ok");
        Ok(result)
    }

    pub async fn mcp_server_resource_read(
        &self,
        server: &str,
        uri: &str,
        thread_id: Option<&str>,
    ) -> Result<Value, String> {
        eprintln!("[codex-rpc] → mcpServer/resource/read server={server} uri={uri}");
        let mut params = json!({ "server": server, "uri": uri });
        if let Some(tid) = thread_id.map(str::trim).filter(|s| !s.is_empty()) {
            params["threadId"] = json!(tid);
        }
        let result = self
            .request(
                ClientRequestMethod::McpServerResourceRead.as_str(),
                params,
            )
            .await
            .map_err(|e| e.to_string())?;
        eprintln!("[codex-rpc] ← mcpServer/resource/read ok");
        Ok(result)
    }

    pub async fn mcp_server_tool_call(
        &self,
        server: &str,
        tool: &str,
        thread_id: &str,
        arguments: Option<Value>,
    ) -> Result<Value, String> {
        eprintln!(
            "[codex-rpc] → mcpServer/tool/call server={server} tool={tool} threadId={thread_id}"
        );
        let mut params = json!({
            "server": server,
            "tool": tool,
            "threadId": thread_id,
        });
        if let Some(args) = arguments {
            params["arguments"] = args;
        }
        let result = self
            .request(ClientRequestMethod::McpServerToolCall.as_str(), params)
            .await
            .map_err(|e| e.to_string())?;
        eprintln!("[codex-rpc] ← mcpServer/tool/call ok");
        Ok(result)
    }

    pub async fn mcp_server_status_list(&self) -> Result<Value, String> {
        eprintln!("[codex-rpc] → mcpServerStatus/list");
        let result = self
            .request(
                ClientRequestMethod::McpServerStatusList.as_str(),
                json!({ "detail": "full" }),
            )
            .await
            .map_err(|e| e.to_string())?;
        eprintln!("[codex-rpc] ← mcpServerStatus/list ok");
        Ok(result)
    }

    pub async fn config_mcp_server_reload(&self) -> Result<Value, String> {
        eprintln!("[codex-rpc] → config/mcpServer/reload");
        let result = self
            .request(ClientRequestMethod::ConfigMcpServerReload.as_str(), Value::Null)
            .await
            .map_err(|e| e.to_string())?;
        eprintln!("[codex-rpc] ← config/mcpServer/reload ok");
        Ok(result)
    }

    pub async fn mcp_server_oauth_login(&self, name: &str) -> Result<Value, String> {
        eprintln!("[codex-rpc] → mcpServer/oauth/login name={name}");
        let result = self
            .request(
                ClientRequestMethod::McpServerOauthLogin.as_str(),
                json!({ "name": name }),
            )
            .await
            .map_err(|e| e.to_string())?;
        eprintln!("[codex-rpc] ← mcpServer/oauth/login ok");
        Ok(result)
    }

    pub async fn experimental_feature_list(&self) -> Result<Value, String> {
        eprintln!("[codex-rpc] → experimentalFeature/list");
        let result = self
            .request(ClientRequestMethod::ExperimentalFeatureList.as_str(), json!({}))
            .await
            .map_err(|e| e.to_string())?;
        eprintln!("[codex-rpc] ← experimentalFeature/list ok");
        Ok(result)
    }

    pub async fn experimental_feature_enablement_set(
        &self,
        enablement: Value,
    ) -> Result<Value, String> {
        eprintln!("[codex-rpc] → experimentalFeature/enablement/set");
        let result = self
            .request(
                ClientRequestMethod::ExperimentalFeatureEnablementSet.as_str(),
                json!({ "enablement": enablement }),
            )
            .await
            .map_err(|e| e.to_string())?;
        eprintln!("[codex-rpc] ← experimentalFeature/enablement/set ok");
        Ok(result)
    }

    pub async fn config_requirements_read(&self) -> Result<Value, String> {
        eprintln!("[codex-rpc] → configRequirements/read");
        let result = self
            .request(ClientRequestMethod::ConfigRequirementsRead.as_str(), json!({}))
            .await
            .map_err(|e| e.to_string())?;
        eprintln!("[codex-rpc] ← configRequirements/read ok");
        Ok(result)
    }

    pub async fn thread_start(
        &self,
        cwd: Option<&str>,
        model: Option<&str>,
        sandbox: &str,
        approval_policy: &str,
        inject_dynamic_tools: bool,
    ) -> Result<Value, String> {
        let dynamic_tools = if inject_dynamic_tools {
            Self::dynamic_tools_param::<DynamicToolSpec>(None)?
        } else {
            None
        };
        let params = ThreadStartParams {
            cwd: cwd
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            sandbox: Some(Self::start_sandbox(sandbox)),
            approval_policy: Some(Self::start_approval(approval_policy)),
            model: model.filter(|s| !s.is_empty()).map(str::to_string),
            developer_instructions: if inject_dynamic_tools {
                crate::host::dynamic_tools::DynamicTools::thread_developer_instructions()
            } else {
                None
            },
            dynamic_tools,
            ..Default::default()
        };
        eprintln!(
            "[codex-rpc] → thread/start cwd={} sandbox={sandbox} approval={approval_policy} dynamicTools={}",
            cwd.unwrap_or("(default)"),
            inject_dynamic_tools
        );
        let result = self
            .request_typed(ClientRequestMethod::ThreadStart, &params)
            .await
            .map_err(|e| e.to_string())?;
        eprintln!(
            "[codex-rpc] ← thread/start threadId={}",
            result
                .pointer("/thread/id")
                .and_then(|v| v.as_str())
                .unwrap_or("?")
        );
        Ok(result)
    }

    pub async fn thread_resume(
        &self,
        thread_id: &str,
        sandbox: &str,
        approval_policy: &str,
        inject_dynamic_tools: bool,
        model: Option<&str>,
    ) -> Result<Value, String> {
        eprintln!(
            "[codex-rpc] → thread/resume threadId={thread_id} sandbox={sandbox} approval={approval_policy} dynamicTools={inject_dynamic_tools}"
        );
        let dynamic_tools = if inject_dynamic_tools {
            Self::dynamic_tools_param::<ResumeDynamicToolSpec>(Some(thread_id))?
        } else {
            None
        };
        let params = ThreadResumeParams {
            thread_id: thread_id.to_string(),
            approval_policy: Some(Self::resume_approval(approval_policy)),
            sandbox: Some(Self::resume_sandbox(sandbox)),
            approvals_reviewer: None,
            base_instructions: None,
            config: None,
            cwd: None,
            developer_instructions: if inject_dynamic_tools {
                crate::host::dynamic_tools::DynamicTools::thread_developer_instructions()
            } else {
                None
            },
            personality: None,
            service_tier: None,
            model: model.filter(|s| !s.is_empty()).map(str::to_string),
            model_provider: None,
            dynamic_tools,
        };
        // Paginated threads deprecate full-history hydration on resume.
        // Generated schema (0.151) may omit excludeTurns; still send it.
        let mut params = serde_json::to_value(&params).map_err(|e| e.to_string())?;
        params["excludeTurns"] = json!(true);
        let result = self
            .request(ClientRequestMethod::ThreadResume.as_str(), params)
            .await
            .map_err(|e| e.to_string())?;
        eprintln!("[codex-rpc] ← thread/resume ok");
        Ok(result)
    }

    pub async fn turn_start(
        &self,
        thread_id: &str,
        text: &str,
        image_paths: &[String],
        skills: &[(String, String)],
        mentions: &[(String, String)],
        model: Option<&str>,
        sandbox: &str,
        approval_policy: &str,
        effort: Option<&str>,
        client_user_message_id: Option<&str>,
    ) -> Result<Value, String> {
        let mut input = Vec::new();
        for (name, path) in skills {
            let n = name.trim();
            let p = path.trim();
            if n.is_empty() || p.is_empty() {
                continue;
            }
            input.push(UserInput::Skill {
                name: n.to_string(),
                path: p.to_string(),
            });
        }
        for (name, path) in mentions {
            let n = name.trim();
            let p = path.trim();
            if n.is_empty() || p.is_empty() {
                continue;
            }
            input.push(UserInput::Mention {
                name: n.to_string(),
                path: p.to_string(),
            });
        }
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            input.push(UserInput::Text {
                text: trimmed.to_string(),
                text_elements: None,
            });
        }
        for path in image_paths {
            let p = path.trim();
            if p.is_empty() {
                continue;
            }
            input.push(UserInput::LocalImage {
                detail: None,
                path: p.to_string(),
            });
        }
        if input.is_empty() {
            return Err("消息不能为空".into());
        }
        let params = TurnStartParams {
            thread_id: thread_id.to_string(),
            input,
            approval_policy: Some(Self::turn_approval(approval_policy)),
            sandbox_policy: Some(Self::turn_sandbox_policy(sandbox)),
            model: model.filter(|s| !s.is_empty()).map(str::to_string),
            approvals_reviewer: None,
            client_user_message_id: client_user_message_id
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            service_tier: None,
            cwd: None,
            effort: effort
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            personality: None,
            output_schema: None,
            summary: None,
        };
        eprintln!(
            "[codex-rpc] → turn/start threadId={thread_id} text_len={} images={}",
            trimmed.len(),
            image_paths.len()
        );
        let result = self
            .request_typed(ClientRequestMethod::TurnStart, &params)
            .await
            .map_err(|e| e.to_string())?;
        eprintln!(
            "[codex-rpc] ← turn/start turnId={}",
            result
                .pointer("/turn/id")
                .and_then(|v| v.as_str())
                .unwrap_or("?")
        );
        Ok(result)
    }

    pub async fn model_provider_capabilities_read(&self) -> Result<Value, String> {
        eprintln!("[codex-rpc] → modelProvider/capabilities/read");
        let result = self
            .request(
                ClientRequestMethod::ModelProviderCapabilitiesRead.as_str(),
                json!({}),
            )
            .await
            .map_err(|e| e.to_string())?;
        eprintln!("[codex-rpc] ← modelProvider/capabilities/read ok");
        Ok(result)
    }

    pub async fn model_list(&self, include_hidden: bool) -> Result<Value, String> {
        eprintln!("[codex-rpc] → model/list includeHidden={include_hidden}");
        let result = self
            .request(
                ClientRequestMethod::ModelList.as_str(),
                json!({ "includeHidden": include_hidden }),
            )
            .await
            .map_err(|e| e.to_string())?;
        eprintln!("[codex-rpc] ← model/list ok");
        Ok(result)
    }

    pub async fn turn_steer(
        &self,
        thread_id: &str,
        expected_turn_id: &str,
        text: &str,
        image_paths: &[String],
        client_user_message_id: Option<&str>,
    ) -> Result<Value, String> {
        eprintln!(
            "[codex-rpc] → turn/steer threadId={thread_id} expectedTurnId={expected_turn_id} text_len={} images={}",
            text.trim().len(),
            image_paths.len()
        );
        let mut input = Vec::new();
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            input.push(json!({ "type": "text", "text": trimmed }));
        }
        for path in image_paths {
            let p = path.trim();
            if p.is_empty() {
                continue;
            }
            input.push(json!({ "type": "localImage", "path": p }));
        }
        if input.is_empty() {
            return Err("消息不能为空".into());
        }
        let mut params = json!({
            "threadId": thread_id,
            "expectedTurnId": expected_turn_id,
            "input": input,
        });
        if let Some(id) = client_user_message_id.filter(|s| !s.is_empty()) {
            params["clientUserMessageId"] = json!(id);
        }
        let result = self
            .request(ClientRequestMethod::TurnSteer.as_str(), params)
            .await
            .map_err(|e| e.to_string())?;
        eprintln!("[codex-rpc] ← turn/steer ok");
        Ok(result)
    }

    pub async fn turn_interrupt(&self, thread_id: &str, turn_id: &str) -> Result<Value, String> {
        eprintln!("[codex-rpc] → turn/interrupt threadId={thread_id} turnId={turn_id}");
        let params = TurnInterruptParams {
            thread_id: thread_id.to_string(),
            turn_id: turn_id.to_string(),
        };
        let result = self
            .request_typed(ClientRequestMethod::TurnInterrupt, &params)
            .await
            .map_err(|e| e.to_string())?;
        eprintln!("[codex-rpc] ← turn/interrupt ok");
        Ok(result)
    }

    pub async fn thread_list_page(
        &self,
        cursor: Option<&str>,
        limit: u32,
        archived: bool,
    ) -> Result<Value, String> {
        self.thread_list_page_ex(cursor, limit, archived, None).await
    }

    pub async fn thread_list_page_ex(
        &self,
        cursor: Option<&str>,
        limit: u32,
        archived: bool,
        search_term: Option<&str>,
    ) -> Result<Value, String> {
        let params = ThreadListParams {
            archived: Some(archived),
            limit: Some(limit),
            sort_key: Some(ThreadSortKey::RecencyAt),
            sort_direction: Some(SortDirection::Desc),
            cursor: cursor.filter(|s| !s.is_empty()).map(str::to_string),
            search_term: search_term
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            ..Default::default()
        };
        eprintln!(
            "[codex-rpc] → thread/list archived={archived} searchTerm={:?}",
            params.search_term
        );
        self.request_typed(ClientRequestMethod::ThreadList, &params)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn thread_read(&self, thread_id: &str, include_turns: bool) -> Result<Value, String> {
        eprintln!("[codex-rpc] → thread/read threadId={thread_id} includeTurns={include_turns}");
        let params = ThreadReadParams {
            thread_id: thread_id.to_string(),
            // Omit false: paginated threads treat includeTurns:true as deprecated.
            include_turns: if include_turns { Some(true) } else { None },
        };
        self.request_typed(ClientRequestMethod::ThreadRead, &params)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn thread_turns_list(
        &self,
        thread_id: &str,
        cursor: Option<&str>,
        limit: u32,
        sort_direction: &str,
        items_view: &str,
    ) -> Result<Value, String> {
        eprintln!(
            "[codex-rpc] → thread/turns/list threadId={thread_id} cursor={cursor:?} view={items_view}"
        );
        let mut params = json!({
            "threadId": thread_id,
            "limit": limit,
            "sortDirection": sort_direction,
            "itemsView": items_view,
        });
        if let Some(c) = cursor.filter(|s| !s.is_empty()) {
            params["cursor"] = json!(c);
        }
        self.request("thread/turns/list", params)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn thread_items_list(
        &self,
        thread_id: &str,
        turn_id: Option<&str>,
        cursor: Option<&str>,
        limit: u32,
        sort_direction: &str,
    ) -> Result<Value, String> {
        eprintln!(
            "[codex-rpc] → thread/items/list threadId={thread_id} turnId={turn_id:?} cursor={cursor:?}"
        );
        let mut params = json!({
            "threadId": thread_id,
            "limit": limit,
            "sortDirection": sort_direction,
        });
        if let Some(tid) = turn_id.filter(|s| !s.is_empty()) {
            params["turnId"] = json!(tid);
        }
        if let Some(c) = cursor.filter(|s| !s.is_empty()) {
            params["cursor"] = json!(c);
        }
        self.request("thread/items/list", params)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn thread_name_set(&self, thread_id: &str, name: &str) -> Result<Value, String> {
        eprintln!("[codex-rpc] → thread/name/set threadId={thread_id}");
        let params = ThreadSetNameParams {
            thread_id: thread_id.to_string(),
            name: name.to_string(),
        };
        self.request_typed(ClientRequestMethod::ThreadNameSet, &params)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn thread_fork(
        &self,
        thread_id: &str,
        last_turn_id: Option<&str>,
    ) -> Result<Value, String> {
        eprintln!(
            "[codex-rpc] → thread/fork threadId={thread_id} lastTurnId={:?}",
            last_turn_id
        );
        let mut params = json!({ "threadId": thread_id, "excludeTurns": true });
        if let Some(turn_id) = last_turn_id.filter(|s| !s.is_empty()) {
            params["lastTurnId"] = json!(turn_id);
        }
        self.request(ClientRequestMethod::ThreadFork.as_str(), params)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn thread_archive(&self, thread_id: &str) -> Result<Value, String> {
        eprintln!("[codex-rpc] → thread/archive threadId={thread_id}");
        self.request(
            ClientRequestMethod::ThreadArchive.as_str(),
            json!({ "threadId": thread_id }),
        )
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn thread_unarchive(&self, thread_id: &str) -> Result<Value, String> {
        eprintln!("[codex-rpc] → thread/unarchive threadId={thread_id}");
        self.request(
            ClientRequestMethod::ThreadUnarchive.as_str(),
            json!({ "threadId": thread_id }),
        )
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn thread_delete(&self, thread_id: &str) -> Result<Value, String> {
        eprintln!("[codex-rpc] → thread/delete threadId={thread_id}");
        self.request(
            ClientRequestMethod::ThreadDelete.as_str(),
            json!({ "threadId": thread_id }),
        )
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn skills_list(
        &self,
        cwds: Option<Vec<String>>,
        force_reload: bool,
    ) -> Result<Value, String> {
        eprintln!(
            "[codex-rpc] → skills/list forceReload={force_reload} cwds={}",
            cwds.as_ref().map(|c| c.len()).unwrap_or(0)
        );
        let mut params = json!({ "forceReload": force_reload });
        if let Some(cwds) = cwds {
            params["cwds"] = json!(cwds);
        }
        self.request(ClientRequestMethod::SkillsList.as_str(), params)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn skills_config_write(
        &self,
        enabled: bool,
        name: Option<&str>,
        path: Option<&str>,
    ) -> Result<Value, String> {
        eprintln!(
            "[codex-rpc] → skills/config/write enabled={enabled} name={:?} path={:?}",
            name, path
        );
        let mut params = json!({ "enabled": enabled });
        if let Some(name) = name {
            params["name"] = json!(name);
        }
        if let Some(path) = path {
            params["path"] = json!(path);
        }
        self.request(ClientRequestMethod::SkillsConfigWrite.as_str(), params)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn plugin_list(&self, cwds: Option<Vec<String>>) -> Result<Value, String> {
        eprintln!(
            "[codex-rpc] → plugin/list cwds={}",
            cwds.as_ref().map(|c| c.len()).unwrap_or(0)
        );
        let mut params = json!({});
        if let Some(cwds) = cwds {
            params["cwds"] = json!(cwds);
        }
        self.request(ClientRequestMethod::PluginList.as_str(), params)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn plugin_installed(&self, cwds: Option<Vec<String>>) -> Result<Value, String> {
        eprintln!(
            "[codex-rpc] → plugin/installed cwds={}",
            cwds.as_ref().map(|c| c.len()).unwrap_or(0)
        );
        let mut params = json!({});
        if let Some(cwds) = cwds {
            params["cwds"] = json!(cwds);
        }
        self.request(ClientRequestMethod::PluginInstalled.as_str(), params)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn plugin_install(
        &self,
        plugin_name: &str,
        marketplace_path: Option<&str>,
        remote_marketplace_name: Option<&str>,
    ) -> Result<Value, String> {
        eprintln!(
            "[codex-rpc] → plugin/install pluginName={plugin_name} marketplacePath={:?} remoteMarketplaceName={:?}",
            marketplace_path, remote_marketplace_name
        );
        let mut params = json!({ "pluginName": plugin_name });
        if let Some(path) = marketplace_path {
            params["marketplacePath"] = json!(path);
        }
        if let Some(name) = remote_marketplace_name {
            params["remoteMarketplaceName"] = json!(name);
        }
        self.request(ClientRequestMethod::PluginInstall.as_str(), params)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn plugin_uninstall(&self, plugin_id: &str) -> Result<Value, String> {
        eprintln!("[codex-rpc] → plugin/uninstall pluginId={plugin_id}");
        self.request(
            ClientRequestMethod::PluginUninstall.as_str(),
            json!({ "pluginId": plugin_id }),
        )
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn plugin_read(
        &self,
        plugin_name: &str,
        marketplace_path: Option<&str>,
        remote_marketplace_name: Option<&str>,
    ) -> Result<Value, String> {
        eprintln!(
            "[codex-rpc] → plugin/read pluginName={plugin_name} marketplacePath={:?} remoteMarketplaceName={:?}",
            marketplace_path, remote_marketplace_name
        );
        let mut params = json!({ "pluginName": plugin_name });
        if let Some(path) = marketplace_path {
            params["marketplacePath"] = json!(path);
        }
        if let Some(name) = remote_marketplace_name {
            params["remoteMarketplaceName"] = json!(name);
        }
        self.request(ClientRequestMethod::PluginRead.as_str(), params)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn thread_compact_start(&self, thread_id: &str) -> Result<Value, String> {
        eprintln!("[codex-rpc] → thread/compact/start threadId={thread_id}");
        self.request(
            ClientRequestMethod::ThreadCompactStart.as_str(),
            json!({ "threadId": thread_id }),
        )
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn review_start(
        &self,
        thread_id: &str,
        target: Value,
        delivery: Option<&str>,
    ) -> Result<Value, String> {
        eprintln!(
            "[codex-rpc] → review/start threadId={thread_id} delivery={:?}",
            delivery
        );
        let mut params = json!({
            "threadId": thread_id,
            "target": target,
        });
        if let Some(d) = delivery {
            params["delivery"] = json!(d);
        }
        self.request(ClientRequestMethod::ReviewStart.as_str(), params)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn thread_goal_get(&self, thread_id: &str) -> Result<Value, String> {
        eprintln!("[codex-rpc] → thread/goal/get threadId={thread_id}");
        self.request(
            ClientRequestMethod::ThreadGoalGet.as_str(),
            json!({ "threadId": thread_id }),
        )
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn thread_goal_set(
        &self,
        thread_id: &str,
        objective: Option<&str>,
        status: Option<&str>,
        token_budget: Option<i64>,
    ) -> Result<Value, String> {
        eprintln!("[codex-rpc] → thread/goal/set threadId={thread_id}");
        let mut params = json!({ "threadId": thread_id });
        if let Some(o) = objective {
            params["objective"] = json!(o);
        }
        if let Some(s) = status {
            params["status"] = json!(s);
        }
        if let Some(b) = token_budget {
            params["tokenBudget"] = json!(b);
        }
        self.request(ClientRequestMethod::ThreadGoalSet.as_str(), params)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn thread_goal_clear(&self, thread_id: &str) -> Result<Value, String> {
        eprintln!("[codex-rpc] → thread/goal/clear threadId={thread_id}");
        self.request(
            ClientRequestMethod::ThreadGoalClear.as_str(),
            json!({ "threadId": thread_id }),
        )
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn command_exec(
        &self,
        command: Vec<String>,
        cwd: Option<&str>,
        process_id: Option<&str>,
        tty: bool,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<Value, String> {
        eprintln!(
            "[codex-rpc] → command/exec argv={} tty={tty} processId={:?}",
            command.len(),
            process_id
        );
        let mut params = json!({ "command": command });
        if let Some(cwd) = cwd {
            params["cwd"] = json!(cwd);
        }
        if let Some(pid) = process_id {
            params["processId"] = json!(pid);
        }
        if tty {
            params["tty"] = json!(true);
            params["streamStdoutStderr"] = json!(true);
            params["streamStdin"] = json!(true);
            // Interactive shells must not use the default command timeout —
            // otherwise the process dies and write/resize see "no active command/exec".
            params["disableTimeout"] = json!(true);
            if let (Some(c), Some(r)) = (cols, rows) {
                params["size"] = json!({ "cols": c, "rows": r });
            }
        }
        self.request(ClientRequestMethod::CommandExec.as_str(), params)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn command_exec_write(
        &self,
        process_id: &str,
        data_base64: &str,
    ) -> Result<Value, String> {
        eprintln!("[codex-rpc] → command/exec/write processId={process_id}");
        self.request(
            ClientRequestMethod::CommandExecWrite.as_str(),
            json!({
                "processId": process_id,
                "deltaBase64": data_base64,
            }),
        )
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn command_exec_resize(
        &self,
        process_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<Value, String> {
        eprintln!(
            "[codex-rpc] → command/exec/resize processId={process_id} cols={cols} rows={rows}"
        );
        self.request(
            ClientRequestMethod::CommandExecResize.as_str(),
            json!({
                "processId": process_id,
                "size": { "cols": cols, "rows": rows },
            }),
        )
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn command_exec_terminate(&self, process_id: &str) -> Result<Value, String> {
        eprintln!("[codex-rpc] → command/exec/terminate processId={process_id}");
        self.request(
            ClientRequestMethod::CommandExecTerminate.as_str(),
            json!({ "processId": process_id }),
        )
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn fs_read_file(&self, path: &str) -> Result<Value, String> {
        eprintln!("[codex-rpc] → fs/readFile path={path}");
        self.request(
            ClientRequestMethod::FsReadFile.as_str(),
            json!({ "path": path }),
        )
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn fs_write_file(&self, path: &str, data_base64: &str) -> Result<Value, String> {
        eprintln!("[codex-rpc] → fs/writeFile path={path}");
        self.request(
            ClientRequestMethod::FsWriteFile.as_str(),
            json!({ "path": path, "dataBase64": data_base64 }),
        )
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn fs_create_directory(
        &self,
        path: &str,
        recursive: Option<bool>,
    ) -> Result<Value, String> {
        eprintln!("[codex-rpc] → fs/createDirectory path={path} recursive={recursive:?}");
        let mut params = json!({ "path": path });
        if let Some(recursive) = recursive {
            params["recursive"] = json!(recursive);
        }
        self.request(
            ClientRequestMethod::FsCreateDirectory.as_str(),
            params,
        )
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn fs_get_metadata(&self, path: &str) -> Result<Value, String> {
        eprintln!("[codex-rpc] → fs/getMetadata path={path}");
        self.request(
            ClientRequestMethod::FsGetMetadata.as_str(),
            json!({ "path": path }),
        )
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn fs_read_directory(&self, path: &str) -> Result<Value, String> {
        eprintln!("[codex-rpc] → fs/readDirectory path={path}");
        self.request(
            ClientRequestMethod::FsReadDirectory.as_str(),
            json!({ "path": path }),
        )
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn fs_remove(
        &self,
        path: &str,
        force: Option<bool>,
        recursive: Option<bool>,
    ) -> Result<Value, String> {
        eprintln!(
            "[codex-rpc] → fs/remove path={path} force={force:?} recursive={recursive:?}"
        );
        let mut params = json!({ "path": path });
        if let Some(force) = force {
            params["force"] = json!(force);
        }
        if let Some(recursive) = recursive {
            params["recursive"] = json!(recursive);
        }
        self.request(ClientRequestMethod::FsRemove.as_str(), params)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn fs_copy(
        &self,
        source_path: &str,
        destination_path: &str,
        recursive: Option<bool>,
    ) -> Result<Value, String> {
        eprintln!(
            "[codex-rpc] → fs/copy source={source_path} dest={destination_path} recursive={recursive:?}"
        );
        let mut params = json!({
            "sourcePath": source_path,
            "destinationPath": destination_path,
        });
        if let Some(recursive) = recursive {
            params["recursive"] = json!(recursive);
        }
        self.request(ClientRequestMethod::FsCopy.as_str(), params)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn fs_watch(&self, path: &str, watch_id: &str) -> Result<Value, String> {
        eprintln!("[codex-rpc] → fs/watch path={path} watchId={watch_id}");
        self.request(
            ClientRequestMethod::FsWatch.as_str(),
            json!({ "path": path, "watchId": watch_id }),
        )
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn fs_unwatch(&self, watch_id: &str) -> Result<Value, String> {
        eprintln!("[codex-rpc] → fs/unwatch watchId={watch_id}");
        self.request(
            ClientRequestMethod::FsUnwatch.as_str(),
            json!({ "watchId": watch_id }),
        )
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn fuzzy_file_search(
        &self,
        query: &str,
        roots: &[String],
        cancellation_token: Option<&str>,
    ) -> Result<Value, String> {
        eprintln!(
            "[codex-rpc] → fuzzyFileSearch query={query:?} roots={} cancel={cancellation_token:?}",
            roots.len()
        );
        let mut params = json!({ "query": query, "roots": roots });
        if let Some(token) = cancellation_token {
            params["cancellationToken"] = json!(token);
        }
        self.request(ClientRequestMethod::FuzzyFileSearch.as_str(), params)
            .await
            .map_err(|e| e.to_string())
    }

    fn spawn_writer(
        mut stdin: ChildStdin,
        mut write_rx: mpsc::UnboundedReceiver<String>,
        pending: Arc<tokio::sync::Mutex<PendingMap>>,
        alive: Arc<AtomicBool>,
    ) -> JoinHandle<()> {
        tokio::spawn(async move {
            while let Some(line) = write_rx.recv().await {
                if let Err(err) = stdin.write_all(line.as_bytes()).await {
                    eprintln!("[codex-rpc] write error: {err}");
                    break;
                }
                if !line.ends_with('\n') {
                    if let Err(err) = stdin.write_all(b"\n").await {
                        eprintln!("[codex-rpc] newline write error: {err}");
                        break;
                    }
                }
                if let Err(err) = stdin.flush().await {
                    eprintln!("[codex-rpc] flush error: {err}");
                    break;
                }
            }
            alive.store(false, Ordering::SeqCst);
            let mut map = pending.lock().await;
            for (_, tx) in map.drain() {
                let _ = tx.send(Err(RpcError::TransportClosed));
            }
        })
    }

    fn spawn_reader(
        stdout: tokio::process::ChildStdout,
        pending: Arc<tokio::sync::Mutex<PendingMap>>,
        incoming_tx: mpsc::UnboundedSender<Incoming>,
        alive: Arc<AtomicBool>,
    ) -> JoinHandle<()> {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let value: Value = match serde_json::from_str(trimmed) {
                    Ok(v) => v,
                    Err(err) => {
                        eprintln!("[codex-rpc] parse error: {err}; line={trimmed}");
                        continue;
                    }
                };
                Self::dispatch_message(value, &pending, &incoming_tx).await;
            }
            alive.store(false, Ordering::SeqCst);
            let mut map = pending.lock().await;
            for (_, tx) in map.drain() {
                let _ = tx.send(Err(RpcError::TransportClosed));
            }
        })
    }

    async fn dispatch_message(
        value: Value,
        pending: &Arc<tokio::sync::Mutex<PendingMap>>,
        incoming_tx: &mpsc::UnboundedSender<Incoming>,
    ) {
        let obj = match value.as_object() {
            Some(o) => o,
            None => return,
        };
        let has_id = obj.contains_key("id");
        let has_method = obj.contains_key("method");
        let has_result = obj.contains_key("result");
        let has_error = obj.contains_key("error");

        if has_id && (has_result || has_error) {
            let id = match obj.get("id").and_then(|v| v.as_u64()) {
                Some(id) => id,
                None => return,
            };
            let result = if has_error {
                let err = obj.get("error").cloned().unwrap_or(Value::Null);
                Err(RpcError::Server {
                    code: err.get("code").and_then(|c| c.as_i64()).unwrap_or(-1),
                    message: err
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("unknown error")
                        .to_string(),
                    data: err.get("data").cloned(),
                })
            } else {
                Ok(obj.get("result").cloned().unwrap_or(Value::Null))
            };
            if let Some(tx) = pending.lock().await.remove(&id) {
                let _ = tx.send(result);
            }
            return;
        }

        if has_id && has_method {
            let method = obj
                .get("method")
                .and_then(|m| m.as_str())
                .unwrap_or("")
                .to_string();
            let params = obj.get("params").cloned().unwrap_or(Value::Null);
            let id = obj.get("id").cloned().unwrap_or(Value::Null);
            let _ = incoming_tx.send(Incoming::ServerRequest { id, method, params });
            return;
        }

        if has_method {
            let method = obj
                .get("method")
                .and_then(|m| m.as_str())
                .unwrap_or("")
                .to_string();
            let params = obj.get("params").cloned().unwrap_or(Value::Null);
            let _ = incoming_tx.send(Incoming::Notification { method, params });
        }
    }

    fn parse_json<T: serde::de::DeserializeOwned>(value: &Value, fallback: T) -> T {
        serde_json::from_value(value.clone()).unwrap_or(fallback)
    }

    fn start_sandbox(s: &str) -> SandboxMode {
        Self::parse_json(&json!(s), SandboxMode::WorkspaceWrite)
    }

    fn start_approval(s: &str) -> AskForApproval {
        AskForApproval::AskForApprovalLiteral(Self::parse_json(
            &json!(s),
            AskForApprovalLiteral::OnRequest,
        ))
    }

    fn resume_sandbox(s: &str) -> ResumeSandboxMode {
        Self::parse_json(&json!(s), ResumeSandboxMode::WorkspaceWrite)
    }

    fn resume_approval(s: &str) -> ResumeAskForApproval {
        ResumeAskForApproval::AskForApprovalLiteral(Self::parse_json(
            &json!(s),
            ResumeAskForApprovalLiteral::OnRequest,
        ))
    }

    fn turn_approval(s: &str) -> TurnAskForApproval {
        TurnAskForApproval::AskForApprovalLiteral(Self::parse_json(
            &json!(s),
            TurnAskForApprovalLiteral::OnRequest,
        ))
    }

    fn turn_sandbox_policy(s: &str) -> SandboxPolicy {
        match s {
            "read-only" => SandboxPolicy::ReadOnly {
                network_access: None,
            },
            "danger-full-access" => SandboxPolicy::DangerFullAccess,
            _ => SandboxPolicy::WorkspaceWrite {
                exclude_slash_tmp: None,
                exclude_tmpdir_env_var: None,
                network_access: None,
                writable_roots: None,
            },
        }
    }

    fn dynamic_tools_param<T: serde::de::DeserializeOwned>(
        thread_id: Option<&str>,
    ) -> Result<Option<Vec<T>>, String> {
        let specs = crate::host::dynamic_tools::DynamicTools::specs_for_thread(thread_id);
        if specs.is_empty() {
            return Ok(None);
        }
        serde_json::from_value(Value::Array(specs))
            .map(Some)
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_server::generated::command_execution_approval_response::{
        CommandExecutionApprovalDecision, CommandExecutionApprovalDecisionLiteral,
        CommandExecutionRequestApprovalResponse,
    };

    #[test]
    fn turn_start_params_serializes_text_input() {
        let params = TurnStartParams {
            thread_id: "t1".into(),
            input: vec![UserInput::Text {
                text: "hello".into(),
                text_elements: None,
            }],
            approval_policy: Some(RpcClient::turn_approval("on-request")),
            sandbox_policy: Some(RpcClient::turn_sandbox_policy("workspace-write")),
            model: None,
            approvals_reviewer: None,
            client_user_message_id: None,
            service_tier: None,
            cwd: None,
            effort: None,
            personality: None,
            output_schema: None,
            summary: None,
        };
        let value = serde_json::to_value(&params).unwrap();
        assert_eq!(value["threadId"], "t1");
        assert_eq!(value["input"][0]["type"], "text");
        assert_eq!(value["input"][0]["text"], "hello");
        assert_eq!(value["approvalPolicy"], "on-request");
        assert_eq!(value["sandboxPolicy"]["type"], "workspaceWrite");
    }

    #[test]
    fn command_approval_accept_serializes_as_schema_literal() {
        let result = CommandExecutionRequestApprovalResponse {
            decision: CommandExecutionApprovalDecision::CommandExecutionApprovalDecisionLiteral(
                CommandExecutionApprovalDecisionLiteral::Accept,
            ),
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value, json!({ "decision": "accept" }));
    }
}

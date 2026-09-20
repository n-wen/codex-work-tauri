use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
    PendingApproval,
    Running,
    Completed,
    Rejected,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRecord {
    pub id: String,
    pub name: String,
    pub arguments: HashMap<String, Value>,
    pub status: ToolCallStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Extract plain text from an App Server `userMessage` item (`content: [{type:text,text}]`).
pub fn user_message_text(item: &Value) -> String {
    let Some(arr) = item.get("content").and_then(|v| v.as_array()) else {
        // Some payloads put text at the top level.
        return item
            .get("text")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
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

pub fn item_to_tool_record(item: &Value) -> ToolCallRecord {
    let id = item
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let item_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");

    let (name, arguments, result, diff_summary, status) = match item_type {
        "commandExecution" => {
            let mut args = HashMap::new();
            if let Some(cmd) = item.get("command") {
                args.insert("command".into(), cmd.clone());
            }
            if let Some(cwd) = item.get("cwd") {
                args.insert("cwd".into(), cwd.clone());
            }
            let status_str = item.get("status").and_then(|v| v.as_str()).unwrap_or("");
            let status = map_tool_status(status_str);
            let result = item
                .get("aggregatedOutput")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| item.get("exitCode").map(|c| format!("exit_code={c}")));
            ("run_command".into(), args, result, None, status)
        }
        "fileChange" => {
            let mut args = HashMap::new();
            let changes = item.get("changes").cloned().unwrap_or(json!([]));
            args.insert("changes".into(), changes.clone());
            let diff_summary = changes
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|c| {
                            let path = c.get("path")?.as_str()?;
                            let diff = c.get("diff").and_then(|d| d.as_str()).unwrap_or("");
                            Some(format!("{path}\n{diff}"))
                        })
                        .collect::<Vec<_>>()
                        .join("\n\n")
                })
                .filter(|s| !s.is_empty());
            let status_str = item.get("status").and_then(|v| v.as_str()).unwrap_or("");
            (
                "write_file".into(),
                args,
                None,
                diff_summary,
                map_tool_status(status_str),
            )
        }
        "mcpToolCall" | "dynamicToolCall" => {
            let mut args = HashMap::new();
            if let Some(a) = item.get("arguments") {
                if let Some(obj) = a.as_object() {
                    for (k, v) in obj {
                        args.insert(k.clone(), v.clone());
                    }
                } else {
                    args.insert("arguments".into(), a.clone());
                }
            }
            let name = if item_type == "mcpToolCall" {
                format!(
                    "mcp:{}:{}",
                    item.get("server").and_then(|v| v.as_str()).unwrap_or("?"),
                    item.get("tool").and_then(|v| v.as_str()).unwrap_or("?")
                )
            } else {
                item.get("tool")
                    .and_then(|v| v.as_str())
                    .unwrap_or("dynamicToolCall")
                    .to_string()
            };
            let status_str = item.get("status").and_then(|v| v.as_str()).unwrap_or("");
            let result = item
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
                .or_else(|| {
                    item.get("result")
                        .map(|r| serde_json::to_string_pretty(r).unwrap_or_default())
                });
            (name, args, result, None, map_tool_status(status_str))
        }
        other => {
            let mut args = HashMap::new();
            args.insert("raw".into(), item.clone());
            (other.to_string(), args, None, None, ToolCallStatus::Running)
        }
    };

    ToolCallRecord {
        id,
        name,
        arguments,
        status,
        result,
        diff_summary,
        error: None,
    }
}

pub fn map_tool_status(status: &str) -> ToolCallStatus {
    match status {
        "completed" => ToolCallStatus::Completed,
        "failed" => ToolCallStatus::Error,
        "declined" => ToolCallStatus::Rejected,
        "inProgress" => ToolCallStatus::Running,
        _ => ToolCallStatus::Running,
    }
}

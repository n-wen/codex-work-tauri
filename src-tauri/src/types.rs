//! Shared IPC envelopes and timestamp helper. Domain DTOs live next to their service.

use chrono::Utc;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OkResult {
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultOrError {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_id: Option<String>,
}

impl ResultOrError {
    pub fn ok() -> Self {
        Self {
            ok: true,
            error: None,
            queued: None,
            pending_id: None,
        }
    }

    pub fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(msg.into()),
            queued: None,
            pending_id: None,
        }
    }

    pub fn queued(pending_id: impl Into<String>) -> Self {
        Self {
            ok: true,
            error: None,
            queued: Some(true),
            pending_id: Some(pending_id.into()),
        }
    }
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

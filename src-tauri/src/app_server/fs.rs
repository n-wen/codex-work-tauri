use crate::runtime::CodexRuntime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub is_file: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMetadata {
    pub path: String,
    pub created_at_ms: i64,
    pub modified_at_ms: i64,
    pub is_directory: bool,
    pub is_file: bool,
    pub is_symlink: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub data_base64: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub byte_length: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FuzzySearchHit {
    pub file_name: String,
    pub match_type: String,
    pub path: String,
    pub root: String,
    pub score: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indices: Option<Vec<u32>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FuzzySearchResult {
    pub files: Vec<FuzzySearchHit>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchHandle {
    pub watch_id: String,
    pub path: String,
}

pub struct Fs {
    runtime: Arc<CodexRuntime>,
}

impl Fs {
    pub fn new(runtime: Arc<CodexRuntime>) -> Self {
        Self { runtime }
    }

    pub async fn read_directory(&self, path: &str) -> Result<Vec<DirEntry>, String> {
        let path = require_abs(path)?;
        let client = self.runtime.connected_client().await?;
        let result = client.fs_read_directory(&path).await?;
        Ok(parse_dir_entries(&path, &result))
    }

    pub async fn read_file(&self, path: &str) -> Result<FileContent, String> {
        let path = require_abs(path)?;
        let client = self.runtime.connected_client().await?;
        let result = client.fs_read_file(&path).await?;
        let data_base64 = result
            .get("dataBase64")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "fs/readFile 响应缺少 dataBase64".to_string())?
            .to_string();
        let bytes = decode_base64(&data_base64)?;
        let byte_length = bytes.len();
        let text = String::from_utf8(bytes).ok().filter(|s| !s.contains('\0'));
        Ok(FileContent {
            path,
            data_base64,
            text,
            byte_length,
        })
    }

    pub async fn write_file(&self, path: &str, data_base64: &str) -> Result<(), String> {
        let path = require_abs(path)?;
        let client = self.runtime.connected_client().await?;
        client.fs_write_file(&path, data_base64).await?;
        Ok(())
    }

    pub async fn write_text_file(&self, path: &str, text: &str) -> Result<(), String> {
        self.write_file(path, &encode_base64(text.as_bytes())).await
    }

    pub async fn create_directory(
        &self,
        path: &str,
        recursive: Option<bool>,
    ) -> Result<(), String> {
        let path = require_abs(path)?;
        let client = self.runtime.connected_client().await?;
        client.fs_create_directory(&path, recursive).await?;
        Ok(())
    }

    pub async fn get_metadata(&self, path: &str) -> Result<FileMetadata, String> {
        let path = require_abs(path)?;
        let client = self.runtime.connected_client().await?;
        let result = client.fs_get_metadata(&path).await?;
        Ok(FileMetadata {
            path,
            created_at_ms: result
                .get("createdAtMs")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            modified_at_ms: result
                .get("modifiedAtMs")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            is_directory: result
                .get("isDirectory")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            is_file: result
                .get("isFile")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            is_symlink: result
                .get("isSymlink")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        })
    }

    pub async fn remove(
        &self,
        path: &str,
        force: Option<bool>,
        recursive: Option<bool>,
    ) -> Result<(), String> {
        let path = require_abs(path)?;
        let client = self.runtime.connected_client().await?;
        client.fs_remove(&path, force, recursive).await?;
        Ok(())
    }

    pub async fn copy(
        &self,
        source_path: &str,
        destination_path: &str,
        recursive: Option<bool>,
    ) -> Result<(), String> {
        let source_path = require_abs(source_path)?;
        let destination_path = require_abs(destination_path)?;
        let client = self.runtime.connected_client().await?;
        client
            .fs_copy(&source_path, &destination_path, recursive)
            .await?;
        Ok(())
    }

    pub async fn watch(&self, path: &str, watch_id: Option<String>) -> Result<WatchHandle, String> {
        let path = require_abs(path)?;
        let watch_id = watch_id
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let client = self.runtime.connected_client().await?;
        let result = client.fs_watch(&path, &watch_id).await?;
        let watched = result
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or(&path)
            .to_string();
        Ok(WatchHandle {
            watch_id,
            path: watched,
        })
    }

    pub async fn unwatch(&self, watch_id: &str) -> Result<(), String> {
        let watch_id = watch_id.trim();
        if watch_id.is_empty() {
            return Err("watchId 不能为空".into());
        }
        let client = self.runtime.connected_client().await?;
        client.fs_unwatch(watch_id).await?;
        Ok(())
    }

    pub async fn fuzzy_file_search(
        &self,
        query: &str,
        roots: Vec<String>,
        cancellation_token: Option<String>,
    ) -> Result<FuzzySearchResult, String> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(FuzzySearchResult { files: vec![] });
        }
        let roots: Vec<String> = roots
            .into_iter()
            .map(|r| r.trim().to_string())
            .filter(|r| !r.is_empty())
            .collect();
        if roots.is_empty() {
            return Err("fuzzyFileSearch 需要至少一个 root".into());
        }
        for root in &roots {
            require_abs(root)?;
        }
        let client = self.runtime.connected_client().await?;
        let result = client
            .fuzzy_file_search(query, &roots, cancellation_token.as_deref())
            .await?;
        Ok(FuzzySearchResult {
            files: parse_fuzzy_hits(&result),
        })
    }
}

fn require_abs(path: &str) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("路径不能为空".into());
    }
    if !Path::new(path).is_absolute() {
        return Err(format!("需要绝对路径：{path}"));
    }
    Ok(path.to_string())
}

fn join_child(parent: &str, name: &str) -> String {
    Path::new(parent).join(name).to_string_lossy().to_string()
}

fn parse_dir_entries(parent: &str, result: &Value) -> Vec<DirEntry> {
    let mut out = Vec::new();
    let entries = result
        .get("entries")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for entry in entries {
        let name = entry
            .get("fileName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        out.push(DirEntry {
            name: name.clone(),
            path: join_child(parent, &name),
            is_directory: entry
                .get("isDirectory")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            is_file: entry
                .get("isFile")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        });
    }
    out.sort_by(|a, b| match (a.is_directory, b.is_directory) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a
            .name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase()),
    });
    out
}

fn parse_fuzzy_hits(result: &Value) -> Vec<FuzzySearchHit> {
    let mut out = Vec::new();
    let files = result
        .get("files")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for file in files {
        let file_name = file
            .get("file_name")
            .or_else(|| file.get("fileName"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let path = file
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if file_name.is_empty() && path.is_empty() {
            continue;
        }
        let indices = file
            .get("indices")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_u64().map(|n| n as u32))
                    .collect::<Vec<_>>()
            });
        out.push(FuzzySearchHit {
            file_name: if file_name.is_empty() {
                Path::new(&path)
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.clone())
            } else {
                file_name
            },
            match_type: file
                .get("match_type")
                .or_else(|| file.get("matchType"))
                .and_then(|v| v.as_str())
                .unwrap_or("file")
                .to_string(),
            path,
            root: file
                .get("root")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            score: file.get("score").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            indices,
        });
    }
    out
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8) | (bytes[i + 2] as u32);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
        out.push(TABLE[(n & 63) as usize] as char);
        i += 3;
    }
    match bytes.len() - i {
        1 => {
            let n = (bytes[i] as u32) << 16;
            out.push(TABLE[((n >> 18) & 63) as usize] as char);
            out.push(TABLE[((n >> 12) & 63) as usize] as char);
            out.push('=');
            out.push('=');
        }
        2 => {
            let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8);
            out.push(TABLE[((n >> 18) & 63) as usize] as char);
            out.push(TABLE[((n >> 12) & 63) as usize] as char);
            out.push(TABLE[((n >> 6) & 63) as usize] as char);
            out.push('=');
        }
        _ => {}
    }
    out
}

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Result<u8, String> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(format!("非法 base64 字符：{}", c as char)),
        }
    }
    let cleaned: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    if cleaned.len() % 4 != 0 {
        return Err("非法 base64 长度".into());
    }
    let mut out = Vec::with_capacity(cleaned.len() / 4 * 3);
    for chunk in cleaned.chunks(4) {
        let a = val(chunk[0])?;
        let b = val(chunk[1])?;
        let pad3 = chunk[2] == b'=';
        let pad4 = chunk[3] == b'=';
        let c = if pad3 { 0 } else { val(chunk[2])? };
        let d = if pad4 { 0 } else { val(chunk[3])? };
        let n = ((a as u32) << 18) | ((b as u32) << 12) | ((c as u32) << 6) | (d as u32);
        out.push(((n >> 16) & 0xff) as u8);
        if !pad3 {
            out.push(((n >> 8) & 0xff) as u8);
        }
        if !pad4 {
            out.push((n & 0xff) as u8);
        }
    }
    Ok(out)
}

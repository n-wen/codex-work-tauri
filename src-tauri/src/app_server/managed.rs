//! Resolve the Codex CLI that was synced from npm into `src-tauri/codex-runtime/`.
//! `settings.codex_bin` remains a dev override. The app does not download at startup.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Codex CLI version this client is built against (`schemas/` + generated RPC types).
/// Source of truth: `src-tauri/CODEX_VERSION`. Must match `package.json` `@openai/codex`.
pub const PINNED_CODEX_VERSION: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/CODEX_VERSION"));

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRuntimeInfo {
    pub version: String,
    pub release_tag: String,
    pub path: Option<String>,
    pub managed: bool,
}

pub struct CodexBin;

impl CodexBin {
    pub fn pinned_version() -> &'static str {
        PINNED_CODEX_VERSION.trim()
    }

    pub fn release_tag(version: &str) -> String {
        format!("rust-v{version}")
    }

    fn binary_file_name() -> &'static str {
        if cfg!(windows) {
            "codex.exe"
        } else {
            "codex"
        }
    }

    pub fn bundled_bin_in(root: &Path) -> PathBuf {
        root.join("bin").join(Self::binary_file_name())
    }

    pub fn default_runtime_roots() -> Vec<PathBuf> {
        let mut roots = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("codex-runtime")];
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                roots.push(dir.join("codex-runtime"));
                roots.push(dir.join("resources").join("codex-runtime"));
                roots.push(dir.join("..").join("Resources").join("codex-runtime"));
            }
        }
        roots
    }

    pub fn resolve_from_roots(
        override_path: Option<&str>,
        roots: &[PathBuf],
    ) -> Result<PathBuf, String> {
        if let Some(p) = override_path.map(str::trim).filter(|s| !s.is_empty()) {
            let path = PathBuf::from(p);
            if path.is_file() {
                return Ok(path);
            }
            return Err(format!("指定的 Codex 路径不存在：{p}"));
        }

        for root in roots {
            let bin = Self::bundled_bin_in(root);
            if bin.is_file() {
                return Ok(bin);
            }
        }

        Err(format!(
            "未找到已打包的 Codex CLI {}。请在 apps/codex-work 执行 npm install 或 npm run dev（会从 npm 拉取锁定版本）。",
            Self::pinned_version()
        ))
    }

    /// Resolve the Codex binary: explicit override, else the npm-synced / bundled tree.
    pub fn ensure_codex_bin(override_path: Option<&str>) -> Result<PathBuf, String> {
        Self::resolve_from_roots(override_path, &Self::default_runtime_roots())
    }

    pub fn runtime_info(override_path: Option<&str>) -> CodexRuntimeInfo {
        let path = Self::ensure_codex_bin(override_path).ok();
        let managed = override_path
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_none();
        CodexRuntimeInfo {
            version: Self::pinned_version().to_string(),
            release_tag: Self::release_tag(Self::pinned_version()),
            path: path.map(|p| p.to_string_lossy().into_owned()),
            managed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn version_file() -> String {
        fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/CODEX_VERSION"))
            .unwrap()
            .trim()
            .to_string()
    }

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "codex-work-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn pinned_matches_version_file() {
        assert_eq!(CodexBin::pinned_version(), version_file());
    }

    #[test]
    fn release_tag_prefix() {
        assert_eq!(CodexBin::release_tag("0.1.0"), "rust-v0.1.0");
    }

    #[test]
    fn override_missing_file_errors() {
        let err = CodexBin::resolve_from_roots(Some("/no/such/codex-bin"), &[]).unwrap_err();
        assert!(err.contains("不存在"));
    }

    #[test]
    fn finds_bin_under_root() {
        let root = temp_dir("runtime-root");
        let bin = CodexBin::bundled_bin_in(&root);
        fs::create_dir_all(bin.parent().unwrap()).unwrap();
        fs::write(&bin, b"x").unwrap();
        assert_eq!(
            CodexBin::resolve_from_roots(None, &[root.clone()]).unwrap(),
            bin
        );
        let _ = fs::remove_dir_all(root);
    }
}

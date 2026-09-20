use serde_json::json;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const PICKER_BRIDGE: &str = include_str!("picker_bridge.js");
const PREVIEW_LABEL_PREFIX: &str = "preview-";
const DRAFT_SESSION_ID: &str = "draft";
const WINDOW_WIDTH: f64 = 1100.0;
const WINDOW_HEIGHT: f64 = 800.0;
/// Desktop Safari UA — some sites (e.g. Baidu) blank out embedded/default WKWebView UAs.
const PREVIEW_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

#[derive(Debug, Clone)]
pub struct Preview {
    app: AppHandle,
}

impl Preview {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    pub fn open_sidebar(&self, url: &str, session_id: &str) -> Result<String, String> {
        let parsed = Self::validate_preview_url(url)?;
        let session_id = Self::normalize_session_id(session_id);
        let href = parsed.as_str().to_string();
        self.app.emit(
            "preview-opened",
            json!({ "url": href, "sessionId": session_id }),
        )
        .map_err(|e| e.to_string())?;
        Ok(format!(
            "已打开侧栏预览 sessionId={session_id} url={href}。用户已能在 Preview 面板看到页面，不要再用 browser/Chrome/node_repl 去截图或验证。"
        ))
    }

    pub fn close_sidebar(&self, session_id: &str) -> Result<String, String> {
        let session_id = Self::normalize_session_id(session_id);
        let _ = Self::destroy_preview_window(&self.app, &session_id);
        self.app.emit("preview-closed", json!({ "sessionId": session_id }))
            .map_err(|e| e.to_string())?;
        Ok(format!("已关闭预览 sessionId={session_id}"))
    }

    pub fn open_or_navigate(
        &self,
        url: &str,
        session_id: &str,
        instance_id: &str,
        force_navigate: bool,
    ) -> Result<(), String> {
        Self::open_or_navigate_window(&self.app, url, session_id, instance_id, force_navigate)
    }

    pub fn destroy_window(&self, session_id: &str) -> Result<(), String> {
        Self::destroy_preview_window(&self.app, &Self::normalize_session_id(session_id))
    }

    pub fn navigate_content(&self, session_id: &str, url: &str) -> Result<(), String> {
        let parsed = Self::validate_preview_url(url)?;
        let sid = Self::normalize_session_id(session_id);
        Self::remember_last_url(&sid, parsed.as_str());
        Self::preview_window(&self.app, &sid)?
            .navigate(parsed)
            .map_err(|e| format!("preview_navigate_failed: {e}"))?;
        let _ = self.app.emit(
            "preview-url-changed",
            json!({ "sessionId": sid, "url": url }),
        );
        Ok(())
    }

    pub fn history_back(&self, session_id: &str) -> Result<(), String> {
        Self::preview_window(&self.app, session_id)?
            .eval("window.history.back()")
            .map_err(|e| e.to_string())
    }

    pub fn history_forward(&self, session_id: &str) -> Result<(), String> {
        Self::preview_window(&self.app, session_id)?
            .eval("window.history.forward()")
            .map_err(|e| e.to_string())
    }

    pub fn reload(&self, session_id: &str) -> Result<(), String> {
        Self::preview_window(&self.app, session_id)?
            .eval("window.location.reload()")
            .map_err(|e| e.to_string())
    }

    pub fn set_focus_session(&self, _session_id: &str) {}

    /// sessionId → instanceId for element-pick / close events.
    fn preview_instances() -> &'static Mutex<HashMap<String, String>> {
    static INSTANCES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    INSTANCES.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// Frontend still reports the focused chat; Agent preview tools bind `DispatchCtx.thread_id`.
    fn normalize_session_id(session_id: &str) -> String {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        DRAFT_SESSION_ID.to_string()
    } else {
        trimmed.to_string()
    }
    }

    fn preview_label(session_id: &str) -> String {
    let mut out = String::with_capacity(PREVIEW_LABEL_PREFIX.len() + session_id.len());
    out.push_str(PREVIEW_LABEL_PREFIX);
    for ch in session_id.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    out
    }

    fn remember_instance(session_id: &str, instance_id: &str) {
    if let Ok(mut g) = Self::preview_instances().lock() {
        g.insert(session_id.to_string(), instance_id.to_string());
    }
    }

    fn forget_instance(session_id: &str) -> Option<String> {
    Self::preview_instances()
        .lock()
        .ok()
        .and_then(|mut g| g.remove(session_id))
    }

    fn instance_for(session_id: &str) -> String {
    Self::preview_instances()
        .lock()
        .ok()
        .and_then(|g| g.get(session_id).cloned())
        .unwrap_or_default()
    }

    fn emit_element_selected(app: &AppHandle, session_id: &str, nav_url: &url::Url) -> bool {
    if nav_url.scheme() != "cw-preview" {
        return true;
    }
    let instance_id = Self::instance_for(session_id);
    if let Some(fragment) = nav_url.fragment() {
        match percent_encoding::percent_decode_str(fragment).decode_utf8() {
            Ok(raw) => match serde_json::from_str::<serde_json::Value>(&raw) {
                Ok(data) => {
                    let _ = app.emit(
                        "preview-element-selected",
                        json!({
                            "sessionId": session_id,
                            "instanceId": instance_id,
                            "data": data,
                        }),
                    );
                }
                Err(e) => eprintln!("[preview] element payload JSON invalid: {e}"),
            },
            Err(e) => eprintln!("[preview] URL decode failed: {e}"),
        }
    }
    false
    }

    fn on_preview_navigation(app: &AppHandle, session_id: &str, nav_url: &url::Url) -> bool {
    if nav_url.scheme() == "cw-preview" {
        return Self::emit_element_selected(app, session_id, nav_url);
    }
    if matches!(nav_url.scheme(), "http" | "https") {
        let href = nav_url.as_str().to_string();
        Self::remember_last_url(session_id, &href);
        let _ = app.emit(
            "preview-url-changed",
            json!({
                "sessionId": session_id,
                "url": href,
            }),
        );
    }
    true
    }

    fn preview_last_urls() -> &'static Mutex<HashMap<String, String>> {
    static URLS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    URLS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn remember_last_url(session_id: &str, url: &str) {
    if let Ok(mut g) = Self::preview_last_urls().lock() {
        g.insert(session_id.to_string(), url.to_string());
    }
    }

    fn peek_last_url(session_id: &str) -> Option<String> {
    Self::preview_last_urls()
        .lock()
        .ok()
        .and_then(|g| g.get(session_id).cloned())
    }

    fn destroy_preview_window(app: &AppHandle, session_id: &str) -> Result<(), String> {
    let label = Self::preview_label(session_id);
    if let Some(win) = app.get_webview_window(&label) {
        win.destroy().map_err(|e| e.to_string())?;
    } else {
        let _ = Self::forget_instance(session_id);
    }
    Ok(())
    }

    fn open_or_navigate_window(
    app: &AppHandle,
    url: &str,
    session_id: &str,
    instance_id: &str,
    force_navigate: bool,
    ) -> Result<(), String> {
    let parsed_url = Self::validate_preview_url(url)?;
    let session_id = Self::normalize_session_id(session_id);
    Self::remember_instance(&session_id, instance_id);

    let label = Self::preview_label(&session_id);

    if let Some(win) = app.get_webview_window(&label) {
        if force_navigate {
            Self::remember_last_url(&session_id, parsed_url.as_str());
            win.navigate(parsed_url.clone())
                .map_err(|e| format!("preview_navigate_failed: {e}"))?;
            let _ = app.emit(
                "preview-url-changed",
                json!({ "sessionId": session_id, "url": parsed_url.as_str() }),
            );
        }
        let _ = win.set_title(&format!("Preview · {session_id}"));
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }

    Self::remember_last_url(&session_id, parsed_url.as_str());
    eprintln!(
        "[preview] open session={session_id} url={}",
        parsed_url.as_str()
    );

    let app_for_nav = app.clone();
    let app_for_close = app.clone();
    let app_for_load = app.clone();
    let sid_nav = session_id.clone();
    let sid_close = session_id.clone();
    let sid_load = session_id.clone();

    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(parsed_url.clone()))
        .title(format!("Preview · {session_id}"))
        .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
        .user_agent(PREVIEW_USER_AGENT)
        .initialization_script(PICKER_BRIDGE)
        .on_page_load(move |webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = webview.eval(PICKER_BRIDGE);
                if let Ok(u) = webview.url() {
                    if matches!(u.scheme(), "http" | "https") {
                        Self::remember_last_url(&sid_load, u.as_str());
                        let _ = app_for_load.emit(
                            "preview-url-changed",
                            json!({ "sessionId": sid_load, "url": u.as_str() }),
                        );
                    }
                }
            }
        })
        .on_navigation(move |nav_url| Self::on_preview_navigation(&app_for_nav, &sid_nav, &nav_url))
        .build()
        .map_err(|e| format!("preview_open_failed: {e}"))?;

    win.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            let iid = Self::forget_instance(&sid_close).unwrap_or_default();
            let last_url = Self::peek_last_url(&sid_close);
            let _ = app_for_close.emit(
                "preview-window-closed",
                json!({
                    "sessionId": sid_close,
                    "instanceId": iid,
                    "url": last_url,
                }),
            );
        }
    });

    Ok(())
    }

    fn preview_window<'a>(
    app: &'a AppHandle,
    session_id: &str,
    ) -> Result<tauri::WebviewWindow, String> {
    let sid = Self::normalize_session_id(session_id);
    app.get_webview_window(&Self::preview_label(&sid))
        .ok_or_else(|| "preview_missing: 预览窗口不存在".into())
    }

    pub fn validate_preview_url(url: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("preview_invalid_url: {e}"))?;
    if !["http", "https"].contains(&parsed.scheme()) {
        return Err(format!(
            "preview_invalid_url: only http/https allowed, got {}",
            parsed.scheme()
        ));
    }
    if parsed.host_str().unwrap_or("").is_empty() {
        return Err("preview_invalid_url: host required".into());
    }
    Ok(parsed)
    }
}

#[cfg(test)]
mod tests {
    use super::Preview;

    #[test]
    fn http_urls_ok() {
        assert!(Preview::validate_preview_url("http://localhost:5173").is_ok());
        assert!(Preview::validate_preview_url("http://127.0.0.1:3000/").is_ok());
        assert!(Preview::validate_preview_url("https://example.com").is_ok());
        assert!(Preview::validate_preview_url("https://example.com/path").is_ok());
    }

    #[test]
    fn rejects_non_http() {
        assert!(Preview::validate_preview_url("ftp://example.com").is_err());
        assert!(Preview::validate_preview_url("file:///tmp/x").is_err());
    }

    #[test]
    fn rejects_missing_host() {
        assert!(Preview::validate_preview_url("http:///").is_err());
    }

    #[test]
    fn label_sanitizes() {
        assert_eq!(Preview::preview_label("abc-123"), "preview-abc-123");
        assert_eq!(Preview::preview_label("a/b:c"), "preview-a_b_c");
    }
}

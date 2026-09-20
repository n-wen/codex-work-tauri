//! Local scheduled tasks (sidebar 「已安排」).
//!
//! Fire path: Scheduler → `try_run` → `runtime.enqueue_cron` → drain → `execute_job`.
//! Never call `turn/start` while `running` — that merges into the active turn.

use super::store::{atomic_write_json, get_cron_jobs_path, read_json_file};
use crate::app_server::permissions::{AgentPermissions, Permissions};
use crate::app_server::sessions::Sessions;
use crate::host::projects::Projects;
use crate::host::settings::Settings;
use crate::runtime::CodexRuntime;
use crate::types::{now_iso, ResultOrError};
use chrono::{DateTime, Local};
use cron::Schedule;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::Notify;
use uuid::Uuid;

static SCHEDULER_STARTED: AtomicBool = AtomicBool::new(false);
static WAKE: Mutex<Option<Arc<Notify>>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CronOrigin {
    NewInProject,
    BindExisting,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CronRepeat {
    AlwaysNew,
    ReuseFirst,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronJobSource {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_task_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronJob {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub cron_expr: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub once_at: Option<String>,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub origin: CronOrigin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<CronRepeat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
    pub approval_policy: String,
    pub timezone: String,
    pub timeout_mins: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<CronJobSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CronStoreFile {
    pub version: u32,
    pub jobs: Vec<CronJob>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertCronJobInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    pub prompt: String,
    /// Either a 5-field cron expression, or empty when using a preset below.
    #[serde(default)]
    pub cron_expr: String,
    /// UI preset: hourly | daily | weekdays | weekly — converted to cron_expr when set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_preset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_hours: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub days: Option<Vec<String>>,
    /// One-shot absolute time (ISO-8601). Mutually exclusive with cron_expr / schedule_preset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub once_at: Option<String>,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub origin: CronOrigin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<CronRepeat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
    #[serde(default)]
    pub approval_policy: Option<String>,
    #[serde(default)]
    pub timeout_mins: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<CronJobSource>,
}

/// Desktop cron / 「已安排」. Construct with injected deps; do not pass runtime on each call.
pub struct CronService {
    runtime: Arc<CodexRuntime>,
    sessions: Arc<Sessions>,
    projects: Arc<Projects>,
    settings: Arc<Settings>,
}

impl CronService {
    pub fn new(
        runtime: Arc<CodexRuntime>,
        sessions: Arc<Sessions>,
        projects: Arc<Projects>,
        settings: Arc<Settings>,
    ) -> Self {
        Self {
            runtime,
            sessions,
            projects,
            settings,
        }
    }

    pub fn list_jobs(&self) -> Vec<CronJob> {
        let mut jobs = Self::load_store().jobs;
        jobs.sort_by(|a, b| a.name.cmp(&b.name));
        jobs
    }

    pub fn get_job(&self, id: &str) -> Option<CronJob> {
        Self::load_store().jobs.into_iter().find(|j| j.id == id)
    }

    pub fn upsert_job(&self, input: UpsertCronJobInput) -> Result<CronJob, String> {
        Self::validate_job_shape(&input)?;
        let once_at = Self::resolve_once_at(&input)?;
        let cron_expr = if once_at.is_some() {
            Self::once_sentinel_expr()
        } else {
            Self::resolve_cron_expr(&input)?
        };
        let now = Local::now();
        let next_iso = if let Some(ref once) = once_at {
            once.clone()
        } else {
            Self::next_run_after(&cron_expr, now)?.to_rfc3339()
        };
        let ts = now_iso();

        let mut file = Self::load_store();
        let job = if let Some(id) = input.id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let idx = file
                .jobs
                .iter()
                .position(|j| j.id == id)
                .ok_or_else(|| "任务不存在".to_string())?;
            let prev = &file.jobs[idx];
            let updated = CronJob {
                id: prev.id.clone(),
                name: input.name.trim().to_string(),
                prompt: input.prompt.trim().to_string(),
                cron_expr,
                once_at: once_at.clone(),
                enabled: input.enabled,
                project_id: input.project_id.filter(|s| !s.trim().is_empty()),
                thread_id: match input.origin {
                    CronOrigin::BindExisting => input.thread_id.filter(|s| !s.trim().is_empty()),
                    CronOrigin::NewInProject => match input.repeat {
                        Some(CronRepeat::ReuseFirst) => prev.thread_id.clone(),
                        _ => None,
                    },
                },
                origin: input.origin.clone(),
                repeat: input.repeat.clone(),
                model: input.model.filter(|s| !s.trim().is_empty()),
                sandbox: input.sandbox.filter(|s| !s.trim().is_empty()),
                approval_policy: input
                    .approval_policy
                    .unwrap_or_else(|| "never".into())
                    .trim()
                    .to_string(),
                timezone: "local".into(),
                timeout_mins: input.timeout_mins.unwrap_or(30).max(1),
                source: input.source.clone().or_else(|| prev.source.clone()),
                last_thread_id: prev.last_thread_id.clone(),
                last_run_at: prev.last_run_at.clone(),
                last_status: prev.last_status.clone(),
                last_error: prev.last_error.clone(),
                next_run_at: if input.enabled {
                    Some(next_iso)
                } else {
                    None
                },
                created_at: prev.created_at.clone(),
                updated_at: ts,
            };
            file.jobs[idx] = updated.clone();
            updated
        } else {
            let job = CronJob {
                id: Uuid::new_v4().to_string(),
                name: input.name.trim().to_string(),
                prompt: input.prompt.trim().to_string(),
                cron_expr,
                once_at: once_at.clone(),
                enabled: input.enabled,
                project_id: input.project_id.filter(|s| !s.trim().is_empty()),
                thread_id: match input.origin {
                    CronOrigin::BindExisting => input.thread_id.filter(|s| !s.trim().is_empty()),
                    CronOrigin::NewInProject => None,
                },
                origin: input.origin.clone(),
                repeat: input.repeat.clone(),
                model: input.model.filter(|s| !s.trim().is_empty()),
                sandbox: input.sandbox.filter(|s| !s.trim().is_empty()),
                approval_policy: input
                    .approval_policy
                    .unwrap_or_else(|| "never".into())
                    .trim()
                    .to_string(),
                timezone: "local".into(),
                timeout_mins: input.timeout_mins.unwrap_or(30).max(1),
                source: input.source.clone(),
                last_thread_id: None,
                last_run_at: None,
                last_status: None,
                last_error: None,
                next_run_at: if input.enabled {
                    Some(next_iso)
                } else {
                    None
                },
                created_at: ts.clone(),
                updated_at: ts,
            };
            file.jobs.push(job.clone());
            job
        };

        Self::save_store(&file)?;
        Self::wake_scheduler();
        Ok(job)
    }

    pub fn delete_job(&self, id: &str) -> Result<(), String> {
        let mut file = Self::load_store();
        let before = file.jobs.len();
        file.jobs.retain(|j| j.id != id);
        if file.jobs.len() == before {
            return Err("任务不存在".into());
        }
        Self::save_store(&file)?;
        self.runtime.cancel_cron_pending(id);
        Self::wake_scheduler();
        Ok(())
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<CronJob, String> {
        let mut file = Self::load_store();
        let job = file
            .jobs
            .iter_mut()
            .find(|j| j.id == id)
            .ok_or_else(|| "任务不存在".to_string())?;
        job.enabled = enabled;
        job.updated_at = now_iso();
        if enabled {
            if let Some(ref once) = job.once_at {
                job.next_run_at = Some(once.clone());
            } else {
                let next = Self::next_run_after(&job.cron_expr, Local::now())?;
                job.next_run_at = Some(next.to_rfc3339());
            }
        } else {
            job.next_run_at = None;
            self.runtime.cancel_cron_pending(id);
        }
        let out = job.clone();
        Self::save_store(&file)?;
        Self::wake_scheduler();
        Ok(out)
    }

    pub fn try_run(&self, job_id: &str, manual: bool) -> ResultOrError {
        let Some(job) = self.get_job(job_id) else {
            return ResultOrError::err("任务不存在");
        };
        if !job.enabled && !manual {
            return ResultOrError::err("任务未启用");
        }

        let newly = self.runtime.enqueue_cron(job_id);
        if newly && !manual {
            Self::advance_next_run(job_id);
        }
        self.runtime.schedule_drain_pub();
        if newly {
            ResultOrError::queued(job_id)
        } else {
            ResultOrError::ok()
        }
    }

    pub async fn run_job_now(&self, job_id: String) -> ResultOrError {
        if let Err(e) = self.runtime.ensure_connected().await {
            return ResultOrError::err(e);
        }
        self.try_run(&job_id, true)
    }

    pub async fn execute_job(self: &Arc<Self>, job_id: String) {
        let app = self.runtime.app();
        match self.execute_job_inner(&job_id).await {
            Ok(thread_id) => {
                let bind = self.get_job(&job_id)
                    .map(|j| {
                        matches!(
                            (&j.origin, j.repeat.as_ref()),
                            (CronOrigin::NewInProject, Some(CronRepeat::ReuseFirst))
                        )
                    })
                    .unwrap_or(false);
                Self::mark_run(&job_id, "ok", Some(&thread_id), None, bind);
                let _ = app.emit(
                    "codex:scheduled",
                    json!({
                        "jobId": job_id,
                        "threadId": thread_id,
                        "status": "ok",
                    }),
                );
                if let Some(job) = self.get_job(&job_id) {
                    let mins = job.timeout_mins.max(1) as u64;
                    let rt = Arc::clone(&self.runtime);
                    let jid = job_id.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(mins * 60)).await;
                        if rt.is_scheduled_job(&jid) {
                            eprintln!("[cron] job {jid} timed out after {mins}m");
                            rt.interrupt().await;
                        }
                    });
                }
            }
            Err(e) => {
                if e.contains("目标会话正在运行") {
                    // Put back — another turn on this thread; drain will retry later.
                    let _ = self.runtime.enqueue_cron(&job_id);
                    self.runtime.schedule_drain_pub();
                    return;
                }
                Self::mark_run(&job_id, "error", None, Some(&e), false);
                let _ = app.emit(
                    "codex:scheduled",
                    json!({
                        "jobId": job_id,
                        "status": "error",
                        "error": e,
                    }),
                );
                self.runtime.force_idle_and_drain();
            }
        }
    }

    async fn execute_job_inner(&self, job_id: &str) -> Result<String, String> {
        let job = self.get_job(job_id).ok_or_else(|| "任务不存在".to_string())?;
        self.runtime.set_scheduled_job(Some(job_id.to_string()));

        let client = self.runtime.client().await?;
        let settings = self.settings.load();
        let model = job
            .model
            .as_deref()
            .or_else(|| settings.as_ref().map(|s| s.default_model()));

        let global = Permissions::read_client(&client)
            .await
            .unwrap_or_else(|_| AgentPermissions::default_auto());
        let sandbox = job.sandbox.as_deref().unwrap_or(global.sandbox.as_str());
        let approval = if job.approval_policy.trim().is_empty() {
            "never"
        } else {
            job.approval_policy.as_str()
        };

        let _cwd = job
            .project_id
            .as_ref()
            .and_then(|id| self.projects.get(id))
            .map(|p| p.work_dir);

        let thread_id = match job.origin {
            CronOrigin::BindExisting => {
                let tid = job
                    .thread_id
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| "bindExisting 缺少 threadId".to_string())?;
                client
                    .thread_resume(tid, sandbox, approval, false, model)
                    .await
                    .map_err(|e| format!("无法恢复绑定会话：{e}"))?;
                tid.to_string()
            }
            CronOrigin::NewInProject => {
                let reuse = matches!(job.repeat, Some(CronRepeat::ReuseFirst));
                if reuse {
                    if let Some(tid) = job.thread_id.as_deref().filter(|s| !s.is_empty()) {
                        match client.thread_resume(tid, sandbox, approval, false, model).await {
                            Ok(_) => tid.to_string(),
                            Err(_) => {
                                self.sessions
                                    .create(
                                        job.project_id.as_deref(),
                                        Some(job.name.clone()),
                                        false,
                                    )
                                    .await?
                                    .id
                            }
                        }
                    } else {
                        self.sessions
                            .create(job.project_id.as_deref(), Some(job.name.clone()), false)
                            .await?
                            .id
                    }
                } else {
                    let title = format!(
                        "{} · {}",
                        job.name,
                        Local::now().format("%m-%d %H:%M")
                    );
                    self.sessions
                        .create(job.project_id.as_deref(), Some(title), false)
                        .await?
                        .id
                }
            }
        };

        self.runtime.emit_event_pub(
            "session/start",
            json!({
                "projectId": job.project_id,
                "sessionId": thread_id,
                "threadId": thread_id,
                "origin": "scheduled",
                "jobId": job_id,
            }),
        );

        if !self.runtime.claim_thread(&thread_id) {
            self.runtime.set_scheduled_job(None);
            return Err("目标会话正在运行，定时任务稍后再试".into());
        }

        if let Err(e) = client
            .turn_start(
                &thread_id,
                &job.prompt,
                &[],
                &[],
                &[],
                model,
                sandbox,
                approval,
                None,
                None,
            )
            .await
        {
            self.runtime.release_thread(&thread_id);
            self.runtime.set_scheduled_job(None);
            return Err(e);
        }

        Ok(thread_id)
    }

    pub fn start_scheduler(self: &Arc<Self>) {
        if SCHEDULER_STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        let notify = Arc::new(Notify::new());
        *WAKE.lock() = Some(Arc::clone(&notify));
        Self::recompute_due_jobs();

        let this = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                let sleep_dur = this.scheduler_tick().await;
                tokio::select! {
                    _ = tokio::time::sleep(sleep_dur) => {}
                    _ = notify.notified() => {}
                }
            }
        });
    }

    async fn scheduler_tick(&self) -> Duration {
        let _ = self.runtime.ensure_connected().await;
        let file = Self::load_store();
        let now = Local::now();
        let mut soonest: Option<DateTime<Local>> = None;

        for job in &file.jobs {
            if !job.enabled {
                continue;
            }
            let Some(iso) = job.next_run_at.as_deref() else {
                continue;
            };
            let Ok(parsed) = DateTime::parse_from_rfc3339(iso) else {
                continue;
            };
            let at = parsed.with_timezone(&Local);
            if at <= now {
                let _ = self.try_run(&job.id, false);
            } else {
                soonest = Some(match soonest {
                    Some(s) if s < at => s,
                    _ => at,
                });
            }
        }

        match soonest {
            Some(at) => {
                let delta = at.signed_duration_since(Local::now());
                let secs = delta.num_seconds().clamp(1, 60) as u64;
                Duration::from_secs(secs)
            }
            None => Duration::from_secs(60),
        }
    }

    fn load_store() -> CronStoreFile {
    read_json_file(
        &get_cron_jobs_path(),
        CronStoreFile {
            version: 1,
            jobs: Vec::new(),
        },
    )
    }

    fn save_store(file: &CronStoreFile) -> Result<(), String> {
    atomic_write_json(&get_cron_jobs_path(), file)
    }

    fn wake_scheduler() {
    if let Some(n) = WAKE.lock().as_ref() {
        n.notify_one();
    }
    }

    fn normalize_cron_expr(expr: &str) -> Result<String, String> {
    let parts: Vec<&str> = expr.split_whitespace().collect();
    let expr6 = match parts.len() {
        5 => format!("0 {}", expr.trim()),
        6 => expr.trim().to_string(),
        _ => return Err("cron 须为 5 字段（分 时 日 月 周）或带秒的 6 字段".into()),
    };
    Schedule::from_str(&expr6).map_err(|e| format!("非法 cron：{e}"))?;
    if parts.len() == 6 && parts[0] == "0" {
        Ok(parts[1..].join(" "))
    } else if parts.len() == 5 {
        Ok(parts.join(" "))
    } else {
        Ok(expr6)
    }
    }

    fn schedule_from_expr(expr: &str) -> Result<Schedule, String> {
    let parts: Vec<&str> = expr.split_whitespace().collect();
    let expr6 = if parts.len() == 5 {
        format!("0 {}", expr.trim())
    } else {
        expr.trim().to_string()
    };
    Schedule::from_str(&expr6).map_err(|e| format!("非法 cron：{e}"))
    }

    pub fn next_run_after(expr: &str, after: DateTime<Local>) -> Result<DateTime<Local>, String> {
    let schedule = Self::schedule_from_expr(expr)?;
    schedule
        .after(&after)
        .next()
        .ok_or_else(|| "无法计算下次执行时间".into())
    }

    fn parse_hhmm(time: &str) -> Result<(u32, u32), String> {
    let parts: Vec<&str> = time.trim().split(':').collect();
    if parts.len() != 2 {
        return Err("时间格式须为 HH:MM".into());
    }
    let h: u32 = parts[0]
        .parse()
        .map_err(|_| "时间格式须为 HH:MM".to_string())?;
    let m: u32 = parts[1]
        .parse()
        .map_err(|_| "时间格式须为 HH:MM".to_string())?;
    if h > 23 || m > 59 {
        return Err("时间超出范围".into());
    }
    Ok((h, m))
    }

    fn weekday_to_cron(day: &str) -> Result<u32, String> {
    match day.to_uppercase().as_str() {
        "SU" | "0" | "7" => Ok(0),
        "MO" | "1" => Ok(1),
        "TU" | "2" => Ok(2),
        "WE" | "3" => Ok(3),
        "TH" | "4" => Ok(4),
        "FR" | "5" => Ok(5),
        "SA" | "6" => Ok(6),
        _ => Err(format!("未知星期：{day}")),
    }
    }

    pub fn preset_to_cron(
    preset: &str,
    time: Option<&str>,
    interval_hours: Option<u32>,
    days: Option<&[String]>,
    ) -> Result<String, String> {
    match preset {
        "hourly" => {
            let n = interval_hours.unwrap_or(1).max(1);
            if let Some(ds) = days.filter(|d| !d.is_empty()) {
                let nums: Result<Vec<_>, _> = ds.iter().map(|d| Self::weekday_to_cron(d)).collect();
                let list = nums?
                    .iter()
                    .map(|n| n.to_string())
                    .collect::<Vec<_>>()
                    .join(",");
                Ok(format!("0 */{n} * * {list}"))
            } else {
                Ok(format!("0 */{n} * * *"))
            }
        }
        "daily" => {
            let (h, m) = Self::parse_hhmm(time.unwrap_or("09:00"))?;
            Ok(format!("{m} {h} * * *"))
        }
        "weekdays" => {
            let (h, m) = Self::parse_hhmm(time.unwrap_or("09:00"))?;
            Ok(format!("{m} {h} * * 1-5"))
        }
        "weekly" => {
            let (h, m) = Self::parse_hhmm(time.unwrap_or("09:00"))?;
            let ds = days.ok_or_else(|| "weekly 需要 days".to_string())?;
            if ds.is_empty() {
                return Err("weekly 需要 days".into());
            }
            let nums: Result<Vec<_>, _> = ds.iter().map(|d| Self::weekday_to_cron(d)).collect();
            let list = nums?
                .iter()
                .map(|n| n.to_string())
                .collect::<Vec<_>>()
                .join(",");
            Ok(format!("{m} {h} * * {list}"))
        }
        _ => Err(format!("未知节奏：{preset}")),
    }
    }

    /// Convert plugin `ScheduledTaskSchedule` JSON into a 5-field cron expression.
    pub fn plugin_schedule_to_cron(schedule: &serde_json::Value) -> Result<String, String> {
        let kind = schedule
            .get("type")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "schedule 缺少 type".to_string())?;
        let time = schedule.get("time").and_then(|v| v.as_str());
        let interval_hours = schedule
            .get("intervalHours")
            .and_then(|v| v.as_u64())
            .map(|n| n as u32);
        let days: Option<Vec<String>> = schedule.get("days").and_then(|v| {
            v.as_array().map(|arr| {
                arr.iter()
                    .filter_map(|d| d.as_str().map(str::to_string))
                    .collect()
            })
        });
        Self::preset_to_cron(kind, time, interval_hours, days.as_deref())
    }

    fn once_sentinel_expr() -> String {
        "once".into()
    }

    fn resolve_once_at(input: &UpsertCronJobInput) -> Result<Option<String>, String> {
        let once = input
            .once_at
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        if let Some(ref iso) = once {
            DateTime::parse_from_rfc3339(iso)
                .map_err(|e| format!("onceAt 须为 ISO-8601：{e}"))?;
        }
        Ok(once)
    }

    fn validate_job_shape(input: &UpsertCronJobInput) -> Result<(), String> {
    if input.name.trim().is_empty() {
        return Err("名称不能为空".into());
    }
    if input.prompt.trim().is_empty() {
        return Err("prompt 不能为空".into());
    }
    if matches!(input.origin, CronOrigin::BindExisting)
        && input
            .thread_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_none()
    {
        return Err("bindExisting 需要 threadId".into());
    }
    let has_once = input
        .once_at
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_some();
    let has_preset = input
        .schedule_preset
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_some();
    let has_cron = {
        let expr = input.cron_expr.trim();
        !expr.is_empty() && expr != "once"
    };
    if has_once && (has_preset || has_cron) {
        return Err("onceAt 与 cronExpr/schedulePreset 互斥".into());
    }
    if !has_once && !has_preset && !has_cron {
        return Err("需要 onceAt、cronExpr 或 schedulePreset".into());
    }
    Ok(())
    }

    fn resolve_cron_expr(input: &UpsertCronJobInput) -> Result<String, String> {
    if let Some(preset) = input
        .schedule_preset
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Self::preset_to_cron(
            preset,
            input.time.as_deref(),
            input.interval_hours,
            input.days.as_deref(),
        );
    }
    let expr = input.cron_expr.trim();
    if expr.is_empty() || expr == "once" {
        return Err("需要 cronExpr 或 schedulePreset".into());
    }
    Self::normalize_cron_expr(expr)
    }

    fn mark_run(
    id: &str,
    status: &str,
    thread_id: Option<&str>,
    error: Option<&str>,
    bind_thread: bool,
    ) {
    let mut file = Self::load_store();
    let Some(job) = file.jobs.iter_mut().find(|j| j.id == id) else {
        return;
    };
    job.last_run_at = Some(now_iso());
    job.last_status = Some(status.into());
    job.last_error = error.map(|s| s.to_string());
    if let Some(tid) = thread_id {
        job.last_thread_id = Some(tid.to_string());
        if bind_thread {
            job.thread_id = Some(tid.to_string());
        }
    }
    job.updated_at = now_iso();
    let _ = Self::save_store(&file);
    }

    fn advance_next_run(id: &str) {
    let mut file = Self::load_store();
    let Some(job) = file.jobs.iter_mut().find(|j| j.id == id) else {
        return;
    };
    if job.once_at.is_some() {
        job.enabled = false;
        job.next_run_at = None;
    } else if !job.enabled {
        job.next_run_at = None;
    } else if let Ok(next) = Self::next_run_after(&job.cron_expr, Local::now()) {
        job.next_run_at = Some(next.to_rfc3339());
    }
    job.updated_at = now_iso();
    let _ = Self::save_store(&file);
    Self::wake_scheduler();
    }

    fn recompute_due_jobs() {
    let mut file = Self::load_store();
    let now = Local::now();
    let mut changed = false;
    for job in &mut file.jobs {
        if !job.enabled {
            if job.next_run_at.is_some() {
                job.next_run_at = None;
                changed = true;
            }
            continue;
        }
        let need = match job.next_run_at.as_deref() {
            None => true,
            Some(iso) => DateTime::parse_from_rfc3339(iso).is_err(),
        };
        if need {
            if let Some(ref once) = job.once_at {
                job.next_run_at = Some(once.clone());
                changed = true;
            } else if let Ok(next) = Self::next_run_after(&job.cron_expr, now) {
                job.next_run_at = Some(next.to_rfc3339());
                changed = true;
            }
        }
    }
    if changed {
        let _ = Self::save_store(&file);
    }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Timelike};

    #[test]
    fn preset_daily() {
        assert_eq!(
            CronService::preset_to_cron("daily", Some("09:30"), None, None).unwrap(),
            "30 9 * * *"
        );
    }

    #[test]
    fn preset_weekdays() {
        assert_eq!(
            CronService::preset_to_cron("weekdays", Some("09:00"), None, None).unwrap(),
            "0 9 * * 1-5"
        );
    }

    #[test]
    fn preset_hourly() {
        assert_eq!(
            CronService::preset_to_cron("hourly", None, Some(2), None).unwrap(),
            "0 */2 * * *"
        );
    }

    #[test]
    fn preset_weekly() {
        assert_eq!(
            CronService::preset_to_cron(
                "weekly",
                Some("09:30"),
                None,
                Some(&["MO".into(), "WE".into()])
            )
            .unwrap(),
            "30 9 * * 1,3"
        );
    }

    #[test]
    fn next_run_parses_5_field() {
        let after = Local.with_ymd_and_hms(2026, 9, 10, 8, 0, 0).unwrap();
        let next = CronService::next_run_after("0 9 * * *", after).unwrap();
        assert_eq!(next.hour(), 9);
        assert_eq!(next.minute(), 0);
    }
}

import { useCallback, useEffect, useState } from 'react';
import { ask } from '@tauri-apps/plugin-dialog';
import { codexApi } from '../api';
import type { CronJob, Project, Session, UpsertCronJobInput } from '../types';

interface Props {
  onClose: () => void;
  /** Close scheduled page and switch chat to the job thread. */
  onFocusRun: (jobId: string, knownThreadId?: string | null) => void;
  projects: Project[];
  sessions: Session[];
}

type ScheduleMode = 'daily' | 'weekdays' | 'weekly' | 'hourly' | 'cron' | 'once';
type OriginMode = 'newInProject' | 'bindExisting';
type RepeatMode = 'alwaysNew' | 'reuseFirst';

const PRESET_LABELS: Record<ScheduleMode, string> = {
  daily: '每天',
  weekdays: '工作日',
  weekly: '每周',
  hourly: '每小时',
  cron: '自定义 cron',
  once: '一次性',
};

function formatNextRun(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function statusLabel(job: CronJob): string {
  if (!job.lastStatus) return '尚未运行';
  if (job.lastStatus === 'ok') return '成功';
  if (job.lastStatus === 'error') return `失败${job.lastError ? `：${job.lastError}` : ''}`;
  return job.lastStatus;
}

export function ScheduledTasksPage({ onClose, onFocusRun, projects, sessions }: Props) {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [projectId, setProjectId] = useState('');
  const [origin, setOrigin] = useState<OriginMode>('newInProject');
  const [repeat, setRepeat] = useState<RepeatMode>('reuseFirst');
  const [threadId, setThreadId] = useState('');
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>('daily');
  const [time, setTime] = useState('09:00');
  const [intervalHours, setIntervalHours] = useState(1);
  const [weeklyDays, setWeeklyDays] = useState('MO,WE,FR');
  const [cronExpr, setCronExpr] = useState('');
  const [onceAtLocal, setOnceAtLocal] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [autostart, setAutostart] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);

  const loadJobs = useCallback(async (opts?: { clearError?: boolean }) => {
    setLoading(true);
    if (opts?.clearError) setError(null);
    try {
      setJobs(await codexApi.listCronJobs());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadJobs({ clearError: true });
    void codexApi.getAutostartEnabled().then(setAutostart).catch(() => undefined);
  }, [loadJobs]);

  useEffect(() => {
    return codexApi.onScheduled((payload) => {
      if (payload.status === 'error') {
        setError(payload.error ?? `任务执行失败（${payload.jobId}）`);
      }
      void loadJobs();
    });
  }, [loadJobs]);

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setPrompt('');
    setProjectId(projects[0]?.id ?? '');
    setOrigin('newInProject');
    setRepeat('reuseFirst');
    setThreadId('');
    setScheduleMode('daily');
    setTime('09:00');
    setIntervalHours(1);
    setWeeklyDays('MO,WE,FR');
    setCronExpr('');
    setOnceAtLocal('');
    setEnabled(true);
  };

  const openCreate = () => {
    resetForm();
    setShowForm(true);
  };

  const openEdit = (job: CronJob) => {
    setEditingId(job.id);
    setName(job.name);
    setPrompt(job.prompt);
    setProjectId(job.projectId ?? '');
    setOrigin(job.origin);
    setRepeat(job.repeat ?? 'reuseFirst');
    setThreadId(job.threadId ?? '');
    setCronExpr(job.cronExpr);
    if (job.onceAt) {
      setScheduleMode('once');
      try {
        const d = new Date(job.onceAt);
        const pad = (n: number) => String(n).padStart(2, '0');
        setOnceAtLocal(
          `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
        );
      } catch {
        setOnceAtLocal('');
      }
    } else {
      setScheduleMode('cron');
      setOnceAtLocal('');
    }
    setEnabled(job.enabled);
    setShowForm(true);
  };

  const buildInput = (): UpsertCronJobInput => {
    const input: UpsertCronJobInput = {
      id: editingId ?? undefined,
      name: name.trim(),
      prompt: prompt.trim(),
      enabled,
      projectId: projectId || null,
      origin,
      approvalPolicy: 'never',
      timeoutMins: 30,
    };

    if (origin === 'newInProject') {
      input.repeat = repeat;
      input.threadId = null;
    } else {
      input.threadId = threadId || null;
      input.repeat = null;
    }

    if (scheduleMode === 'once') {
      if (!onceAtLocal.trim()) {
        throw new Error('请选择一次性执行时间');
      }
      input.onceAt = new Date(onceAtLocal).toISOString();
      input.cronExpr = 'once';
    } else if (scheduleMode === 'cron') {
      input.cronExpr = cronExpr.trim();
    } else {
      input.schedulePreset = scheduleMode;
      input.time = time;
      if (scheduleMode === 'hourly') {
        input.intervalHours = intervalHours;
      }
      if (scheduleMode === 'weekly') {
        input.days = weeklyDays
          .split(',')
          .map((d) => d.trim().toUpperCase())
          .filter(Boolean);
      }
    }

    return input;
  };

  const toggleAutostart = async (next: boolean) => {
    setAutostartBusy(true);
    setError(null);
    try {
      setAutostart(await codexApi.setAutostartEnabled(next));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAutostartBusy(false);
    }
  };

  const saveJob = async () => {
    setError(null);
    try {
      await codexApi.upsertCronJob(buildInput());
      setShowForm(false);
      resetForm();
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleEnabled = async (job: CronJob) => {
    setBusyId(job.id);
    setError(null);
    try {
      await codexApi.setCronJobEnabled(job.id, !job.enabled);
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const runNow = async (job: CronJob) => {
    setBusyId(job.id);
    setError(null);
    try {
      const result = await codexApi.runCronJobNow(job.id);
      if (!result.ok) {
        setError(result.error ?? '立即运行失败');
        return;
      }
      // Reuse / bind: thread already known → switch now.
      // alwaysNew / first run: wait for session/start or codex:scheduled.
      const knownThreadId =
        job.origin === 'bindExisting'
          ? job.threadId
          : job.origin === 'newInProject' && job.repeat === 'reuseFirst'
            ? job.threadId
            : null;
      onFocusRun(job.id, knownThreadId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const deleteJob = async (job: CronJob) => {
    const ok = await ask(`删除已安排任务「${job.name}」？`, {
      title: '删除任务',
      kind: 'warning',
    });
    if (!ok) return;
    setBusyId(job.id);
    setError(null);
    try {
      await codexApi.deleteCronJob(job.id);
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const projectSessions = sessions.filter(
    (s) => !projectId || s.projectId === projectId,
  );

  return (
    <div className="settings-page">
      <aside className="settings-nav">
        <button type="button" className="settings-back" onClick={onClose}>
          ← 返回应用
        </button>
        <div className="settings-nav-group">
          <div className="settings-nav-group-label">自动化</div>
          <button type="button" className="settings-nav-item active">
            已安排
          </button>
        </div>
      </aside>

      <main className="settings-main">
        <header className="settings-main-head">
          <div className="archived-section-head">
            <div>
              <h1>已安排</h1>
              <p>
                周期 prompt 在应用运行时自动触发。关闭应用会错过计划时间；busy 时任务会进入 cron
                排队车道。
              </p>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={autostart}
                  disabled={autostartBusy}
                  onChange={(e) => void toggleAutostart(e.target.checked)}
                />
                开机启动应用（便于调度器跟上）
              </label>
            </div>
            <button type="button" className="btn btn-create" onClick={openCreate}>
              + 新建任务
            </button>
          </div>
        </header>

        {error && <div className="error-banner">{error}</div>}

        {showForm && (
          <div className="create-project-panel" style={{ marginBottom: 16 }}>
            <h2 style={{ margin: '0 0 12px', fontSize: 16 }}>
              {editingId ? '编辑任务' : '新建任务'}
            </h2>
            <div className="create-row">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="任务名称"
              />
            </div>
            <div className="create-row">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="到点发送的 prompt"
                rows={3}
                style={{ width: '100%', resize: 'vertical' }}
              />
            </div>
            <div className="create-row">
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">默认目录</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="create-row">
              <label>
                <input
                  type="radio"
                  checked={origin === 'newInProject'}
                  onChange={() => setOrigin('newInProject')}
                />{' '}
                项目下新开
              </label>
              <label style={{ marginLeft: 12 }}>
                <input
                  type="radio"
                  checked={origin === 'bindExisting'}
                  onChange={() => setOrigin('bindExisting')}
                />{' '}
                绑定已有对话
              </label>
            </div>
            {origin === 'newInProject' && (
              <div className="create-row">
                <select
                  value={repeat}
                  onChange={(e) => setRepeat(e.target.value as RepeatMode)}
                >
                  <option value="reuseFirst">后续接着第一次</option>
                  <option value="alwaysNew">后续每次新开</option>
                </select>
              </div>
            )}
            {origin === 'bindExisting' && (
              <div className="create-row">
                <select value={threadId} onChange={(e) => setThreadId(e.target.value)}>
                  <option value="">选择会话</option>
                  {projectSessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title || s.id}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="create-row">
              <select
                value={scheduleMode}
                onChange={(e) => setScheduleMode(e.target.value as ScheduleMode)}
              >
                {Object.entries(PRESET_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            {scheduleMode !== 'cron' && scheduleMode !== 'hourly' && scheduleMode !== 'once' && (
              <div className="create-row">
                <input
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                />
              </div>
            )}
            {scheduleMode === 'once' && (
              <div className="create-row">
                <input
                  type="datetime-local"
                  value={onceAtLocal}
                  onChange={(e) => setOnceAtLocal(e.target.value)}
                />
              </div>
            )}
            {scheduleMode === 'hourly' && (
              <div className="create-row">
                <input
                  type="number"
                  min={1}
                  value={intervalHours}
                  onChange={(e) => setIntervalHours(Number(e.target.value) || 1)}
                  placeholder="间隔小时"
                />
              </div>
            )}
            {scheduleMode === 'weekly' && (
              <div className="create-row">
                <input
                  value={weeklyDays}
                  onChange={(e) => setWeeklyDays(e.target.value)}
                  placeholder="星期，如 MO,WE,FR"
                />
              </div>
            )}
            {scheduleMode === 'cron' && (
              <div className="create-row">
                <input
                  value={cronExpr}
                  onChange={(e) => setCronExpr(e.target.value)}
                  placeholder="5 字段 cron，如 0 9 * * *"
                />
              </div>
            )}
            <div className="create-row">
              <label>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />{' '}
                启用
              </label>
            </div>
            <div className="create-row" style={{ gap: 8, display: 'flex' }}>
              <button type="button" className="btn btn-primary" onClick={() => void saveJob()}>
                保存
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setShowForm(false);
                  resetForm();
                }}
              >
                取消
              </button>
            </div>
          </div>
        )}

        {loading && !jobs.length ? (
          <div className="empty-hint">加载中…</div>
        ) : !jobs.length ? (
          <div className="empty-hint">还没有已安排任务。应用保持运行才会按时触发。</div>
        ) : (
          <ul className="ext-list">
            {jobs.map((job) => {
              const busy = busyId === job.id;
              return (
                <li key={job.id} className="ext-item">
                  <div className="ext-item-body">
                    <div className="ext-item-title">
                      {job.name}
                      {!job.enabled && <span className="ext-badge muted">已禁用</span>}
                    </div>
                    <div className="ext-item-desc">
                      {job.onceAt
                        ? `一次性 · ${formatNextRun(job.onceAt)}`
                        : `${job.cronExpr} · 下次 ${formatNextRun(job.nextRunAt)}`}{' '}
                      · {statusLabel(job)}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                    <label className="ext-switch">
                      <input
                        type="checkbox"
                        checked={job.enabled}
                        disabled={busy}
                        onChange={() => void toggleEnabled(job)}
                      />
                      <span>{job.enabled ? '开' : '关'}</span>
                    </label>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={busy}
                      onClick={() => void runNow(job)}
                    >
                      立即跑
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={busy}
                      onClick={() => openEdit(job)}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={busy}
                      onClick={() => void deleteJob(job)}
                    >
                      删除
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}

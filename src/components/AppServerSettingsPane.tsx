import { useEffect, useState } from 'react';
import { codexApi } from '../api';
import type { AppConfigSnapshot, ExperimentalFeature, PermissionProfile } from '../types';

const EFFORTS = ['', 'minimal', 'low', 'medium', 'high', 'xhigh'];

/** `configRequirements/read` → `{ requirements: ConfigRequirements | null }`.
 *  `null` means no requirements.toml/MDM — not a missing prerequisite. */
function summarizeRequirements(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  const req = 'requirements' in obj ? obj.requirements : raw;
  if (req == null || typeof req !== 'object') return [];

  const out: string[] = [];
  const r = req as Record<string, unknown>;

  const collect = (label: string, v: unknown) => {
    if (v == null) return;
    if (typeof v === 'string' && v.trim()) out.push(`${label}：${v}`);
    else if (Array.isArray(v)) {
      for (const item of v) out.push(`${label}：${String(item)}`);
    } else if (typeof v === 'object') {
      const miss = (v as { missing?: unknown }).missing;
      if (Array.isArray(miss) && miss.length) {
        for (const m of miss) out.push(`${label}：${String(m)}`);
      } else if ((v as { satisfied?: boolean }).satisfied === false) {
        out.push(`${label} 未满足`);
      }
    }
  };

  collect('模型', r.models ?? r.model);
  collect('MCP', r.mcp ?? r.mcpServers);
  collect('缺项', r.missing ?? r.items ?? r.errors);

  for (const [k, v] of Object.entries(r)) {
    if (v && typeof v === 'object' && (v as { satisfied?: boolean }).satisfied === false) {
      if (!out.some((line) => line.startsWith(k))) out.push(`${k} 未满足`);
    }
  }
  return out;
}

export function AppServerSettingsPane() {
  const [config, setConfig] = useState<AppConfigSnapshot | null>(null);
  const [features, setFeatures] = useState<ExperimentalFeature[]>([]);
  const [requirements, setRequirements] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<PermissionProfile[]>([]);
  const [effort, setEffort] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const reload = async () => {
    setBusy(true);
    setError(null);
    try {
      const [cfg, feats, req, profs] = await Promise.all([
        codexApi.readAppConfig(),
        codexApi.listExperimentalFeatures(),
        codexApi.readConfigRequirements().catch(() => null),
        codexApi.listPermissionProfiles().catch(() => [] as PermissionProfile[]),
      ]);
      setConfig(cfg);
      setEffort(cfg.modelReasoningEffort ?? '');
      setFeatures(feats.filter((f) => f.stage === 'beta' || f.stage === 'Beta' || f.displayName));
      setRequirements(summarizeRequirements(req));
      setProfiles(profs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const saveEffort = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await codexApi.writeAppConfigValue(
        'model_reasoning_effort',
        effort.trim() ? effort.trim() : null,
      );
      setConfig(next);
      setEffort(next.modelReasoningEffort ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleFeature = async (name: string, enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const next = await codexApi.setExperimentalFeature(name, enabled);
      setFeatures(next.filter((f) => f.stage === 'beta' || f.stage === 'Beta' || f.displayName));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="settings-main-head">
        <div className="archived-section-head">
          <div>
            <h1>App Server</h1>
            <p>同步合并后的 config、实验开关，以及运行前缺项提示。</p>
          </div>
          <button type="button" className="btn btn-ghost" onClick={() => void reload()} disabled={busy}>
            刷新
          </button>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      {!!requirements.length && (
        <div className="error-banner">
          <strong>运行前缺项：</strong>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {requirements.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      <section className="settings-pane-form" style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 15, margin: '0 0 8px' }}>默认推理强度</h2>
        <p className="form-hint" style={{ marginTop: 0 }}>
          写入 App Server `model_reasoning_effort`（会话/轮次可再覆盖）。当前合并 model：
          {config?.model ? ` ${config.model}` : ' （未读到）'}
        </p>
        <div className="provider-row">
          <select value={effort} onChange={(e) => setEffort(e.target.value)} disabled={busy}>
            {EFFORTS.map((e) => (
              <option key={e || 'default'} value={e}>
                {e || '（默认 / 清空）'}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void saveEffort()}>
            保存到 config
          </button>
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ marginTop: 10 }}
          onClick={() => setShowRaw((v) => !v)}
        >
          {showRaw ? '隐藏' : '显示'}合并后的 config JSON
        </button>
        {showRaw && config && (
          <pre className="approval-diff" style={{ marginTop: 8, maxHeight: 280 }}>
            {JSON.stringify(config.config, null, 2)}
          </pre>
        )}
      </section>

      <section className="settings-pane-form" style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 15, margin: '0 0 8px' }}>权限档案</h2>
        <p className="form-hint" style={{ marginTop: 0 }}>
          来自 `permissionProfile/list`。选用后写入 `default_permissions`；Composer 三档快捷预设仍可用。
        </p>
        {!profiles.length ? (
          <div className="empty-hint">暂无档案（或 App Server 未返回）</div>
        ) : (
          <ul className="ext-list">
            {profiles.map((p) => (
              <li key={p.id} className="ext-item">
                <div className="ext-item-body">
                  <div className="archived-title">{p.id}</div>
                  <div className="form-hint" style={{ margin: 0 }}>
                    {p.description || (p.allowed ? '可选' : '当前环境不允许')}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !p.allowed}
                  onClick={() => {
                    void (async () => {
                      setBusy(true);
                      setError(null);
                      try {
                        await codexApi.setDefaultPermissionProfile(p.id);
                      } catch (err) {
                        setError(err instanceof Error ? err.message : String(err));
                      } finally {
                        setBusy(false);
                      }
                    })();
                  }}
                >
                  设为默认
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="settings-pane-form">
        <h2 style={{ fontSize: 15, margin: '0 0 8px' }}>实验功能</h2>
        <p className="form-hint" style={{ marginTop: 0 }}>
          `experimentalFeature/list` + `enablement/set`。仅展示有名称说明的条目。
        </p>
        {!features.length ? (
          <div className="empty-hint">{busy ? '加载中…' : '暂无可用实验项'}</div>
        ) : (
          <ul className="archived-list">
            {features.map((f) => (
              <li key={f.name} className="archived-item">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="archived-title">{f.displayName || f.name}</div>
                  {!!f.description && (
                    <div className="form-hint" style={{ margin: 0 }}>
                      {f.description}
                    </div>
                  )}
                </div>
                <label className="approval-check" style={{ margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={f.enabled}
                    disabled={busy}
                    onChange={(e) => void toggleFeature(f.name, e.target.checked)}
                  />
                  启用
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

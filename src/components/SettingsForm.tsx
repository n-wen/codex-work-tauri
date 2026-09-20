import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type {
  AppSettings,
  CodexRuntimeInfo,
  ModelEntry,
  ProviderEntry,
} from '../types';
import { legacyToAppSettings } from '../types';

interface Props {
  initial?: Partial<AppSettings> & {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
  title?: string;
  subtitle?: string;
  submitLabel?: string;
  onSubmit: (settings: AppSettings) => Promise<{ ok: true } | { ok: false; error: string }>;
  onCancel?: () => void;
  maskApiKey?: (key: string) => string;
  embedded?: boolean;
}

function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeInitial(
  initial?: Props['initial'],
): AppSettings {
  return legacyToAppSettings(initial);
}

export function SettingsForm({
  initial,
  title = '模型设置',
  subtitle = '配置 Provider 与模型。切换网关会重启 App Server；会话内换模型不重启。',
  submitLabel = '保存并开始',
  onSubmit,
  onCancel,
  embedded = false,
}: Props) {
  const seed = useMemo(() => normalizeInitial(initial), [initial]);
  const [providers, setProviders] = useState<ProviderEntry[]>(seed.providers);
  const [activeProviderId, setActiveProviderId] = useState(seed.activeProviderId);
  const [codexBin, setCodexBin] = useState(seed.codexBin ?? '');
  const [editorCommand, setEditorCommand] = useState(seed.editorCommand ?? '');
  const [runtime, setRuntime] = useState<CodexRuntimeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void invoke<CodexRuntimeInfo>('get_codex_runtime')
      .then(setRuntime)
      .catch(() => setRuntime(null));
  }, []);

  const active =
    providers.find((p) => p.id === activeProviderId) ?? providers[0] ?? null;

  const updateActive = (patch: Partial<ProviderEntry>) => {
    if (!active) return;
    setProviders((list) =>
      list.map((p) => (p.id === active.id ? { ...p, ...patch } : p)),
    );
  };

  const updateModel = (modelId: string, patch: Partial<ModelEntry>) => {
    if (!active) return;
    setProviders((list) =>
      list.map((p) =>
        p.id !== active.id
          ? p
          : {
              ...p,
              models: p.models.map((m) => (m.id === modelId ? { ...m, ...patch } : m)),
            },
      ),
    );
  };

  const addModel = () => {
    if (!active) return;
    const id = newId('m');
    updateActive({
      models: [...active.models, { id, label: '', model: '' }],
    });
  };

  const removeModel = (modelId: string) => {
    if (!active || active.models.length <= 1) return;
    updateActive({ models: active.models.filter((m) => m.id !== modelId) });
  };

  const addProvider = () => {
    const id = newId('p');
    const next: ProviderEntry = {
      id,
      label: `网关 ${providers.length + 1}`,
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      models: [{ id: newId('m'), label: 'gpt-4o-mini', model: 'gpt-4o-mini' }],
    };
    setProviders((list) => [...list, next]);
    setActiveProviderId(id);
  };

  const removeProvider = () => {
    if (providers.length <= 1 || !active) return;
    const next = providers.filter((p) => p.id !== active.id);
    setProviders(next);
    setActiveProviderId(next[0]?.id ?? '');
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await onSubmit({
      providers,
      activeProviderId: active?.id ?? activeProviderId,
      codexBin: codexBin.trim() || undefined,
      editorCommand: editorCommand.trim() || undefined,
    });
    setBusy(false);
    if (!result.ok) setError(result.error);
  };

  return (
    <form className={embedded ? 'settings-pane-form' : 'panel'} onSubmit={handleSubmit}>
      {!embedded && (
        <>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </>
      )}
      {error && <div className="error-banner">{error}</div>}

      <div className="form-field">
        <label>当前 Provider</label>
        <div className="provider-row">
          <select
            value={active?.id ?? ''}
            onChange={(e) => setActiveProviderId(e.target.value)}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label || p.id}
              </option>
            ))}
          </select>
          <button type="button" className="btn" onClick={addProvider}>
            添加网关
          </button>
          <button
            type="button"
            className="btn"
            onClick={removeProvider}
            disabled={providers.length <= 1}
          >
            删除
          </button>
        </div>
        <span className="form-hint">切换当前网关并保存后会重启 App Server</span>
      </div>

      {active && (
        <>
          <div className="form-field">
            <label htmlFor="providerLabel">显示名</label>
            <input
              id="providerLabel"
              value={active.label}
              onChange={(e) => updateActive({ label: e.target.value })}
              autoComplete="off"
            />
          </div>

          <div className="form-field">
            <label htmlFor="baseUrl">baseUrl</label>
            <input
              id="baseUrl"
              value={active.baseUrl}
              onChange={(e) => updateActive({ baseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
              autoComplete="off"
            />
            <span className="form-hint">
              Provider 根路径（注入为 Codex model_provider；官方要求 wire_api=responses）
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="apiKey">apiKey</label>
            <input
              id="apiKey"
              type="password"
              value={active.apiKey}
              onChange={(e) => updateActive({ apiKey: e.target.value })}
              placeholder="sk-..."
              autoComplete="off"
            />
            <span className="form-hint">仅保存在本机；启动 App Server 时注入环境变量</span>
          </div>

          <div className="form-field">
            <label>模型列表</label>
            <span className="form-hint">
              Composer 下拉使用这些条目；每条为显示名 + API model id。
              {runtime
                ? ` 本应用锁定 Codex ${runtime.version}（${runtime.releaseTag}）。`
                : ' 本应用使用 npm 锁定版本的 Codex CLI。'}
            </span>
            <div className="models-editor">
              {active.models.map((m) => (
                <div key={m.id} className="model-row">
                  <input
                    value={m.label}
                    onChange={(e) => updateModel(m.id, { label: e.target.value })}
                    placeholder="显示名"
                    autoComplete="off"
                  />
                  <input
                    value={m.model}
                    onChange={(e) => updateModel(m.id, { model: e.target.value })}
                    placeholder="model id"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={() => removeModel(m.id)}
                    disabled={active.models.length <= 1}
                    title="删除"
                  >
                    ×
                  </button>
                </div>
              ))}
              <button type="button" className="btn" onClick={addModel}>
                添加模型
              </button>
            </div>
          </div>
        </>
      )}

      <div className="form-field">
        <label htmlFor="editorCommand">首选编辑器命令</label>
        <input
          id="editorCommand"
          value={editorCommand}
          onChange={(e) => setEditorCommand(e.target.value)}
          placeholder={navigator.platform.toLowerCase().includes('win') ? 'code.cmd' : 'code'}
          autoComplete="off"
        />
        <span className="form-hint">
          文件面板 / 侧栏「用 IDE 打开」使用。可填 code、code.cmd、绝对路径或其它编辑器命令。
        </span>
      </div>

      <div className="form-field">
        <label htmlFor="codexBin">codexBin（开发覆盖，可选）</label>
        <input
          id="codexBin"
          value={codexBin}
          onChange={(e) => setCodexBin(e.target.value)}
          placeholder="留空则使用锁定版本"
          autoComplete="off"
        />
        <span className="form-hint">
          仅调试时填写本地二进制。留空则使用 npm 同步并打包进来的锁定版本。
        </span>
      </div>

      <div className="panel-actions">
        {onCancel && !embedded && (
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            取消
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? '校验中…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

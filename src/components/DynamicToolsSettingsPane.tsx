import { useCallback, useEffect, useMemo, useState } from 'react';
import { codexApi } from '../api';
import type { DynamicToolListItem, DynamicToolsListResult } from '../types';

export function DynamicToolsSettingsPane() {
  const [data, setData] = useState<DynamicToolsListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await codexApi.listDynamicTools());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => {
    if (!data) return [];
    const map = new Map<
      string,
      {
        namespace: string;
        label: string;
        description: string;
        enabled: boolean;
        tools: DynamicToolListItem[];
      }
    >();
    for (const t of data.tools) {
      let g = map.get(t.namespace);
      if (!g) {
        g = {
          namespace: t.namespace,
          label: t.namespaceLabel,
          description: t.namespaceDescription,
          enabled: t.namespaceEnabled,
          tools: [],
        };
        map.set(t.namespace, g);
      }
      g.tools.push(t);
    }
    return Array.from(map.values());
  }, [data]);

  const save = async (next: DynamicToolsListResult) => {
    setBusy(true);
    setError(null);
    try {
      const namespaces: Record<string, { enabled: boolean; tools: Record<string, boolean> }> =
        {};
      for (const t of next.tools) {
        if (!namespaces[t.namespace]) {
          namespaces[t.namespace] = {
            enabled: t.namespaceEnabled,
            tools: {},
          };
        }
        namespaces[t.namespace].tools[t.name] = t.enabled;
        namespaces[t.namespace].enabled = t.namespaceEnabled;
      }
      const saved = await codexApi.setDynamicToolsConfig({
        enabled: next.enabled,
        namespaces,
      });
      setData(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const setBusEnabled = (enabled: boolean) => {
    if (!data) return;
    void save({ ...data, enabled });
  };

  const setNamespaceEnabled = (namespace: string, enabled: boolean) => {
    if (!data) return;
    void save({
      ...data,
      tools: data.tools.map((t) =>
        t.namespace === namespace ? { ...t, namespaceEnabled: enabled } : t,
      ),
    });
  };

  const setToolEnabled = (namespace: string, name: string, enabled: boolean) => {
    if (!data) return;
    void save({
      ...data,
      tools: data.tools.map((t) =>
        t.namespace === namespace && t.name === name ? { ...t, enabled } : t,
      ),
    });
  };

  return (
    <>
      <header className="settings-main-head">
        <h1>桌面工具</h1>
        <p>
          允许 Agent 在对话中调用本机能力（实验）。关闭后新对话不再注入这些工具；调用改本机数据时仍会弹出确认。
        </p>
      </header>
      {error && <div className="error-banner">{error}</div>}
      {!data ? (
        <div className="empty-hint">加载中…</div>
      ) : (
        <div className="settings-pane-form">
          <label className="form-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <input
              type="checkbox"
              checked={data.enabled}
              disabled={busy}
              onChange={(e) => setBusEnabled(e.target.checked)}
            />
            <span>
              <strong>允许 Agent 使用桌面工具</strong>
              <div className="form-hint">应用未运行时，依赖本机闹钟的能力不会触发。</div>
            </span>
          </label>

          {!data.tools.length ? (
            <div className="empty-hint">暂无可用桌面工具</div>
          ) : (
            groups.map((g) => (
              <section key={g.namespace} style={{ marginTop: 24 }}>
                <label
                  className="form-field"
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}
                >
                  <input
                    type="checkbox"
                    checked={g.enabled && data.enabled}
                    disabled={busy || !data.enabled}
                    onChange={(e) => setNamespaceEnabled(g.namespace, e.target.checked)}
                  />
                  <span>
                    <strong>{g.label}</strong>
                    <code style={{ marginLeft: 8, opacity: 0.7 }}>{g.namespace}</code>
                    <div className="form-hint">{g.description}</div>
                  </span>
                </label>
                <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0 28px' }}>
                  {g.tools.map((t) => (
                    <li key={`${t.namespace}.${t.name}`} style={{ marginBottom: 12 }}>
                      <label
                        className="form-field"
                        style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}
                      >
                        <input
                          type="checkbox"
                          checked={t.enabled && g.enabled && data.enabled}
                          disabled={busy || !data.enabled || !g.enabled}
                          onChange={(e) => setToolEnabled(t.namespace, t.name, e.target.checked)}
                        />
                        <span>
                          <strong>{t.label}</strong>
                          <code style={{ marginLeft: 8, opacity: 0.7 }}>{t.name}</code>
                          <div className="form-hint">{t.description}</div>
                          <div className="form-hint">
                            {t.sideEffect === 'mutate'
                              ? '会改本机数据（调用时确认）'
                              : '只读'}
                          </div>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      )}
    </>
  );
}

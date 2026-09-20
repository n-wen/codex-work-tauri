import { useCallback, useEffect, useMemo, useState } from 'react';
import { codexApi } from '../api';
import type { DynamicToolListItem, DynamicToolsListResult } from '../types';

interface Props {
  threadId: string;
  open: boolean;
  onClose: () => void;
  embedded?: boolean;
}

export function SessionDynamicToolsPopover({ threadId, open, onClose, embedded }: Props) {
  const [data, setData] = useState<DynamicToolsListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await codexApi.listSessionDynamicTools(threadId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [threadId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const groups = useMemo(() => {
    if (!data) return [];
    const map = new Map<
      string,
      {
        namespace: string;
        label: string;
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
          namespaces[t.namespace] = { enabled: t.namespaceEnabled, tools: {} };
        }
        namespaces[t.namespace].tools[t.name] = t.enabled;
        namespaces[t.namespace].enabled = t.namespaceEnabled;
      }
      const saved = await codexApi.setSessionDynamicTools(threadId, {
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

  const clearOverride = async () => {
    setBusy(true);
    setError(null);
    try {
      setData(await codexApi.clearSessionDynamicTools(threadId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className={`permissions-popover session-tools-popover${embedded ? ' embedded' : ''}`}
      role="dialog"
      aria-label="本会话桌面工具"
    >
      <div className="session-tools-popover-header">
        <strong>本会话桌面工具</strong>
        {!embedded && (
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            关闭
          </button>
        )}
      </div>
      <p className="form-hint" style={{ marginTop: 4 }}>
        覆盖仅作用于当前会话；清除后恢复全局设置。
        {data?.hasSessionOverride ? '（已覆盖）' : ''}
      </p>
      {error && <div className="error-banner">{error}</div>}
      {!data ? (
        <div className="empty-hint">加载中…</div>
      ) : (
        <>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={data.enabled}
              disabled={busy}
              onChange={(e) => void save({ ...data, enabled: e.target.checked })}
            />
            启用桌面工具总线
          </label>
          {groups.map((g) => (
            <div key={g.namespace} style={{ marginBottom: 10 }}>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={g.enabled}
                  disabled={busy || !data.enabled}
                  onChange={(e) =>
                    void save({
                      ...data,
                      tools: data.tools.map((t) =>
                        t.namespace === g.namespace
                          ? { ...t, namespaceEnabled: e.target.checked }
                          : t,
                      ),
                    })
                  }
                />
                <strong>{g.label}</strong>
              </label>
              <div style={{ marginLeft: 22, marginTop: 4 }}>
                {g.tools.map((t) => (
                  <label
                    key={t.name}
                    style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}
                  >
                    <input
                      type="checkbox"
                      checked={t.enabled}
                      disabled={busy || !data.enabled || !g.enabled}
                      onChange={(e) =>
                        void save({
                          ...data,
                          tools: data.tools.map((x) =>
                            x.namespace === t.namespace && x.name === t.name
                              ? { ...x, enabled: e.target.checked }
                              : x,
                          ),
                        })
                      }
                    />
                    {t.label}
                  </label>
                ))}
              </div>
            </div>
          ))}
          {data.hasSessionOverride && (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => void clearOverride()}
            >
              清除本会话覆盖
            </button>
          )}
        </>
      )}
    </div>
  );
}

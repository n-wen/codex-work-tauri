import { useEffect, useState } from 'react';
import { ask, open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { codexApi } from '../api';
import type { McpServerRow, UpsertMcpServerInput } from '../types';

function IconRefresh() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M21 12a9 9 0 1 1-2.6-6.2" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function IconRestart() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v6h6" />
      <path d="M12 8v4l3 2" />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

function IconPencil() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

function IconTools() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M14.7 6.3a4 4 0 0 0-5.6 5.6L4 17l3 3 5.1-5.1a4 4 0 0 0 5.6-5.6L16 11l-3-3 1.7-1.7z" />
    </svg>
  );
}

function IconKey() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="8" cy="15" r="4" />
      <path d="M11.5 12.5L20 4h3v3l-6 6" />
    </svg>
  );
}

const emptyForm = (): UpsertMcpServerInput => ({
  name: '',
  enabled: true,
  transport: 'stdio',
  command: '',
  args: [],
  cwd: '',
  url: '',
  envText: '',
});

export function McpSettingsPane() {
  const [rows, setRows] = useState<McpServerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<UpsertMcpServerInput | null>(null);
  const [argsText, setArgsText] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [resourceUri, setResourceUri] = useState('');
  const [resourcePreview, setResourcePreview] = useState<string | null>(null);
  const [toolName, setToolName] = useState('');
  const [toolArgs, setToolArgs] = useState('{}');
  const [toolResult, setToolResult] = useState<string | null>(null);
  const [toolThreadId, setToolThreadId] = useState('');

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await codexApi.listMcpServers());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    const off = codexApi.onEvent((ev) => {
      if (
        ev.method === 'mcpServer/startupStatus/updated' ||
        ev.method === 'mcpServer/oauthLogin/completed'
      ) {
        void reload();
      }
    });
    return off;
  }, []);

  const startCreate = () => {
    setEditing(emptyForm());
    setArgsText('');
  };

  const startEdit = (row: McpServerRow) => {
    setEditing({
      name: row.name,
      enabled: row.enabled,
      transport: row.transport === 'http' ? 'http' : 'stdio',
      command: row.command ?? '',
      args: row.args,
      cwd: row.cwd ?? '',
      url: row.url ?? '',
      envText: row.envText,
    });
    setArgsText(row.args.join(' '));
  };

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      const input: UpsertMcpServerInput = {
        ...editing,
        args: argsText
          .split(/\s+/)
          .map((s) => s.trim())
          .filter(Boolean),
      };
      setRows(await codexApi.upsertMcpServer(input));
      setEditing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    const ok = await ask(`删除 MCP 服务器「${name}」？`, {
      title: '删除 MCP',
      kind: 'warning',
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      setRows(await codexApi.deleteMcpServer(name));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const oauth = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      const url = await codexApi.mcpServerOauthLogin(name);
      await openUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const pickCwd = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === 'string' && editing) {
      setEditing({ ...editing, cwd: dir });
    }
  };

  return (
    <>
      <header className="settings-main-head">
        <div className="archived-section-head">
          <div>
            <h1>MCP</h1>
            <p>配置写入 App Server `mcp_servers`；保存后自动 reload，可查看 tools / 授权状态。</p>
          </div>
          <div className="provider-row">
            <button
              type="button"
              className="icon-btn"
              title="刷新列表"
              disabled={busy || loading}
              onClick={() => void reload()}
            >
              <IconRefresh />
            </button>
            <button
              type="button"
              className="icon-btn"
              title="重载 MCP 进程"
              disabled={busy}
              onClick={() =>
                void codexApi.reloadMcpServers().then(setRows).catch((e) => setError(String(e)))
              }
            >
              <IconRestart />
            </button>
            <button
              type="button"
              className="icon-btn"
              title="添加"
              disabled={busy}
              onClick={startCreate}
            >
              <IconPlus />
            </button>
          </div>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      {editing && (
        <div className="settings-pane-form" style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 15, marginTop: 0 }}>
            {rows.some((r) => r.name === editing.name) ? '编辑' : '新增'} MCP 服务器
          </h2>
          <div className="form-field">
            <label>名称</label>
            <input
              value={editing.name}
              disabled={rows.some((r) => r.name === editing.name)}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder="my-server"
            />
          </div>
          <div className="form-field">
            <label>传输</label>
            <select
              value={editing.transport}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  transport: e.target.value === 'http' ? 'http' : 'stdio',
                })
              }
            >
              <option value="stdio">stdio（command）</option>
              <option value="http">HTTP（url）</option>
            </select>
          </div>
          {editing.transport === 'http' ? (
            <div className="form-field">
              <label>url</label>
              <input
                value={editing.url ?? ''}
                onChange={(e) => setEditing({ ...editing, url: e.target.value })}
                placeholder="https://…"
              />
            </div>
          ) : (
            <>
              <div className="form-field">
                <label>command</label>
                <input
                  value={editing.command ?? ''}
                  onChange={(e) => setEditing({ ...editing, command: e.target.value })}
                  placeholder="npx"
                />
              </div>
              <div className="form-field">
                <label>args（空格分隔）</label>
                <input
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  placeholder="-y @modelcontextprotocol/server-filesystem ."
                />
              </div>
              <div className="form-field">
                <label>cwd（可选）</label>
                <div className="provider-row">
                  <input
                    value={editing.cwd ?? ''}
                    onChange={(e) => setEditing({ ...editing, cwd: e.target.value })}
                  />
                  <button type="button" className="btn" onClick={() => void pickCwd()}>
                    选择…
                  </button>
                </div>
              </div>
            </>
          )}
          <div className="form-field">
            <label>env（每行 KEY=VALUE）</label>
            <textarea
              rows={4}
              value={editing.envText ?? ''}
              onChange={(e) => setEditing({ ...editing, envText: e.target.value })}
            />
          </div>
          <label className="approval-check">
            <input
              type="checkbox"
              checked={editing.enabled}
              onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
            />
            启用
          </label>
          <div className="panel-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => setEditing(null)}>
              取消
            </button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
              保存并重载
            </button>
          </div>
        </div>
      )}

      {loading && !rows.length ? (
        <div className="empty-hint">加载中…</div>
      ) : !rows.length ? (
        <div className="empty-hint">尚未配置 MCP 服务器</div>
      ) : (
        <ul className="ext-list">
          {rows.map((row) => (
            <li key={row.name} className="ext-item">
              <div className="ext-item-body">
                <div className="archived-title">{row.name}</div>
                <div className="form-hint" style={{ margin: 0 }}>
                  {row.transport === 'http' ? row.url : `${row.command ?? ''} ${row.args.join(' ')}`.trim()}
                  {row.authStatus ? ` · auth: ${row.authStatus}` : ''}
                  {row.enabled ? '' : ' · 已禁用'}
                </div>
                {expanded === row.name && (
                  <div style={{ marginTop: 8 }}>
                    {!!row.tools.length && (
                      <ul className="approval-actions">
                        {row.tools.map((t) => (
                          <li key={t.name}>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              style={{ padding: '0 4px' }}
                              onClick={() => {
                                setToolName(t.name);
                                setToolResult(null);
                              }}
                            >
                              <strong>{t.name}</strong>
                            </button>
                            {t.description ? ` — ${t.description}` : ''}
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="form-field" style={{ marginTop: 8 }}>
                      <label>读 resource（uri）</label>
                      <div className="provider-row">
                        <input
                          value={resourceUri}
                          onChange={(e) => setResourceUri(e.target.value)}
                          placeholder="resource://…"
                        />
                        <button
                          type="button"
                          className="btn"
                          disabled={busy || !resourceUri.trim()}
                          onClick={() => {
                            void (async () => {
                              setBusy(true);
                              setError(null);
                              try {
                                const res = await codexApi.mcpServerResourceRead(
                                  row.name,
                                  resourceUri.trim(),
                                );
                                setResourcePreview(JSON.stringify(res, null, 2));
                              } catch (err) {
                                setError(err instanceof Error ? err.message : String(err));
                              } finally {
                                setBusy(false);
                              }
                            })();
                          }}
                        >
                          读取
                        </button>
                      </div>
                      {resourcePreview && (
                        <pre className="approval-diff" style={{ maxHeight: 180 }}>
                          {resourcePreview}
                        </pre>
                      )}
                    </div>
                    <div className="form-field">
                      <label>手动调 tool</label>
                      <input
                        value={toolName}
                        onChange={(e) => setToolName(e.target.value)}
                        placeholder="tool name"
                      />
                      <input
                        value={toolThreadId}
                        onChange={(e) => setToolThreadId(e.target.value)}
                        placeholder="当前会话 threadId"
                        style={{ marginTop: 6 }}
                      />
                      <textarea
                        value={toolArgs}
                        onChange={(e) => setToolArgs(e.target.value)}
                        rows={3}
                        placeholder='arguments JSON，如 {}'
                        style={{ marginTop: 6, width: '100%' }}
                      />
                      <button
                        type="button"
                        className="btn"
                        style={{ marginTop: 6 }}
                        disabled={busy || !toolName.trim() || !toolThreadId.trim()}
                        onClick={() => {
                          void (async () => {
                            setBusy(true);
                            setError(null);
                            try {
                              let args: unknown = {};
                              try {
                                args = JSON.parse(toolArgs || '{}');
                              } catch {
                                throw new Error('arguments 不是合法 JSON');
                              }
                              const res = await codexApi.mcpServerToolCall(
                                row.name,
                                toolName.trim(),
                                toolThreadId.trim(),
                                args,
                              );
                              setToolResult(JSON.stringify(res, null, 2));
                            } catch (err) {
                              setError(err instanceof Error ? err.message : String(err));
                            } finally {
                              setBusy(false);
                            }
                          })();
                        }}
                      >
                        调用
                      </button>
                      {toolResult && (
                        <pre className="approval-diff" style={{ maxHeight: 180 }}>
                          {toolResult}
                        </pre>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <div className="provider-row" style={{ flexShrink: 0 }}>
                <button
                  type="button"
                  className={`icon-btn${expanded === row.name ? ' active' : ''}`}
                  title={
                    expanded === row.name
                      ? '收起工具'
                      : `工具 (${row.tools.length})`
                  }
                  onClick={() => setExpanded((v) => (v === row.name ? null : row.name))}
                >
                  <IconTools />
                </button>
                {row.authStatus === 'notLoggedIn' && (
                  <button
                    type="button"
                    className="icon-btn"
                    title="OAuth 登录"
                    disabled={busy}
                    onClick={() => void oauth(row.name)}
                  >
                    <IconKey />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn"
                  title="编辑"
                  disabled={busy}
                  onClick={() => startEdit(row)}
                >
                  <IconPencil />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="删除"
                  disabled={busy}
                  onClick={() => void remove(row.name)}
                >
                  <IconTrash />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

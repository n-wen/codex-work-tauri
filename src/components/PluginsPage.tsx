import { useEffect, useMemo, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { ask } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { codexApi } from '../api';
import type {
  PluginDetail,
  PluginInfo,
  PluginScheduledTask,
  SkillInfo,
} from '../types';

type Section = 'skills' | 'plugins';

interface Props {
  onClose: () => void;
  /** Optional project work dirs for repo-scoped discovery. */
  cwds?: string[];
  /** Default project for 「添加到已安排」. */
  defaultProjectId?: string | null;
}

function IconAt() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a9 9 0 1 0-3.5 7.2" />
    </svg>
  );
}

function IconSpark() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 3l1.6 5.2L19 10l-5.4 1.8L12 17l-1.6-5.2L5 10l5.4-1.8L12 3z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" />
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M21 12a9 9 0 1 1-2.6-6.2" />
      <path d="M21 3v6h-6" />
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

function IconDownload() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

function IconExternal() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M14 3h7v7" />
      <path d="M10 14L21 3" />
      <path d="M21 14v7H3V3h7" />
    </svg>
  );
}

function scopeLabel(scope: string): string {
  switch (scope) {
    case 'user':
      return '用户';
    case 'repo':
      return '仓库';
    case 'system':
      return '系统';
    case 'admin':
      return '管理员';
    default:
      return scope;
  }
}

function pluginLogoSrc(plugin: PluginInfo): string | null {
  const local = plugin.logo || plugin.logoDark;
  if (local) {
    try {
      return convertFileSrc(local);
    } catch {
      /* fall through */
    }
  }
  return plugin.logoUrl || plugin.logoUrlDark || null;
}

function skillIconSrc(skill: SkillInfo, large = false): string | null {
  const local = large
    ? skill.iconLarge || skill.iconSmall
    : skill.iconSmall || skill.iconLarge;
  if (!local) return null;
  try {
    return convertFileSrc(local);
  } catch {
    return local;
  }
}

function skillKey(skill: SkillInfo): string {
  return skill.path || skill.name;
}

function PluginAvatar({
  plugin,
  size = 40,
}: {
  plugin: PluginInfo;
  size?: number;
}) {
  const src = pluginLogoSrc(plugin);
  const label = (plugin.displayName || plugin.name || '?').trim().slice(0, 1).toUpperCase();
  const bg = plugin.brandColor || 'var(--bg-active)';
  return (
    <div
      className="plugin-avatar"
      style={{ width: size, height: size, background: src ? 'transparent' : bg }}
      aria-hidden
    >
      {src ? (
        <img src={src} alt="" />
      ) : (
        <span style={{ fontSize: Math.max(12, size * 0.4) }}>{label}</span>
      )}
    </div>
  );
}

function SkillAvatar({
  skill,
  size = 40,
  large = false,
}: {
  skill: SkillInfo;
  size?: number;
  large?: boolean;
}) {
  const src = skillIconSrc(skill, large);
  const label = (skill.displayName || skill.name || '?').trim().slice(0, 1).toUpperCase();
  const bg = skill.brandColor || 'var(--bg-active)';
  return (
    <div
      className="plugin-avatar"
      style={{ width: size, height: size, background: src ? 'transparent' : bg }}
      aria-hidden
    >
      {src ? (
        <img src={src} alt="" />
      ) : (
        <span style={{ fontSize: Math.max(12, size * 0.4) }}>{label}</span>
      )}
    </div>
  );
}

function enrichFromDetail(plugin: PluginInfo, detail: PluginDetail): PluginInfo {
  const iface = detail.summary?.interface;
  if (!iface) return plugin;
  return {
    ...plugin,
    displayName: plugin.displayName || iface.displayName || undefined,
    description:
      plugin.description || iface.shortDescription || detail.description || undefined,
    longDescription:
      plugin.longDescription || iface.longDescription || detail.description || undefined,
    category: plugin.category || iface.category || undefined,
    developerName: plugin.developerName || iface.developerName || undefined,
    brandColor: plugin.brandColor || iface.brandColor || undefined,
    logo: plugin.logo || iface.logo || undefined,
    logoDark: plugin.logoDark || iface.logoDark || undefined,
    logoUrl: plugin.logoUrl || iface.logoUrl || undefined,
    logoUrlDark: plugin.logoUrlDark || iface.logoUrlDark || undefined,
    websiteUrl: plugin.websiteUrl || iface.websiteUrl || undefined,
    capabilities:
      plugin.capabilities?.length
        ? plugin.capabilities
        : iface.capabilities ?? undefined,
    screenshotUrls:
      plugin.screenshotUrls?.length
        ? plugin.screenshotUrls
        : iface.screenshotUrls ?? undefined,
    screenshots:
      plugin.screenshots?.length ? plugin.screenshots : iface.screenshots ?? undefined,
    defaultPrompts:
      plugin.defaultPrompts?.length
        ? plugin.defaultPrompts
        : iface.defaultPrompt ?? undefined,
  };
}

export function PluginsPage({ onClose, cwds, defaultProjectId }: Props) {
  const [section, setSection] = useState<Section>('skills');
  const [query, setQuery] = useState('');
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  /** Cached `plugin/read` by plugin id. */
  const [detailById, setDetailById] = useState<Record<string, PluginDetail>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSkillKey, setSelectedSkillKey] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const selectedPlugin = useMemo(
    () => (selectedId ? plugins.find((p) => p.id === selectedId) ?? null : null),
    [plugins, selectedId],
  );
  const selectedDetail = selectedId ? detailById[selectedId] : undefined;
  const selectedSkill = useMemo(
    () =>
      selectedSkillKey
        ? skills.find((s) => skillKey(s) === selectedSkillKey) ?? null
        : null,
    [skills, selectedSkillKey],
  );

  const loadSkills = async (forceReload = false) => {
    setLoading(true);
    setError(null);
    try {
      const list = await codexApi.listSkills(cwds, forceReload);
      setSkills(list);
      setSelectedSkillKey((id) =>
        id && list.some((s) => skillKey(s) === id) ? id : null,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const loadPlugins = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await codexApi.listPlugins(cwds);
      setPlugins(list);
      setSelectedId((id) => (id && list.some((p) => p.id === id) ? id : null));
      setDetailById((cache) => {
        const next: Record<string, PluginDetail> = {};
        for (const p of list) {
          if (cache[p.id]) next[p.id] = cache[p.id];
        }
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPlugins([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (section === 'skills') void loadSkills();
    else void loadPlugins();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, cwds?.join('|')]);

  useEffect(() => {
    return codexApi.onEvent((event) => {
      if (event.method === 'skills/changed' && section === 'skills') {
        void loadSkills(true);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, cwds?.join('|')]);

  const ensureDetail = async (plugin: PluginInfo, force = false) => {
    if (!force && detailById[plugin.id]) return detailById[plugin.id];
    setDetailLoading(true);
    setError(null);
    try {
      const res = await codexApi.pluginRead(
        plugin.name,
        plugin.marketplacePath,
        plugin.remoteMarketplaceName,
      );
      const detail = res.plugin ?? {};
      setDetailById((m) => ({ ...m, [plugin.id]: detail }));
      setPlugins((list) =>
        list.map((p) => (p.id === plugin.id ? enrichFromDetail(p, detail) : p)),
      );
      return detail;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setDetailLoading(false);
    }
  };

  const openDetail = (plugin: PluginInfo) => {
    setSelectedId(plugin.id);
    void ensureDetail(plugin);
  };

  const filteredSkills = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((s) => {
      const hay = [
        s.name,
        s.displayName ?? '',
        s.description,
        s.shortDescription ?? '',
        s.scope,
        s.cwd ?? '',
        ...(s.dependencies ?? []).flatMap((d) => [d.value, d.description ?? '']),
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [skills, query]);

  const filteredPlugins = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return plugins;
    return plugins.filter((p) => {
      const hay = [
        p.name,
        p.displayName ?? '',
        p.description ?? '',
        p.longDescription ?? '',
        p.category ?? '',
        p.developerName ?? '',
        p.marketplaceName,
        p.id,
        ...(p.keywords ?? []),
        ...(p.capabilities ?? []),
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [plugins, query]);

  const toggleSkill = async (skill: SkillInfo, enabled: boolean) => {
    const key = skillKey(skill);
    setBusyKey(key);
    setError(null);
    try {
      const effective = await codexApi.setSkillEnabled(
        enabled,
        skill.path ? undefined : skill.name || undefined,
        skill.path || undefined,
      );
      setSkills((list) =>
        list.map((s) =>
          skillKey(s) === key ? { ...s, enabled: effective } : s,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const installPlugin = async (plugin: PluginInfo) => {
    setBusyKey(plugin.id);
    setError(null);
    try {
      await codexApi.installPlugin(
        plugin.name,
        plugin.marketplacePath ?? undefined,
        plugin.remoteMarketplaceName ?? undefined,
      );
      await loadPlugins();
      setSelectedId(plugin.id);
      void ensureDetail(plugin, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const uninstallPlugin = async (plugin: PluginInfo) => {
    const label = plugin.displayName || plugin.name;
    const ok = await ask(`卸载插件「${label}」？`, {
      title: '卸载插件',
      kind: 'warning',
    });
    if (!ok) return;
    setBusyKey(plugin.id);
    setError(null);
    try {
      await codexApi.uninstallPlugin(plugin.id);
      if (selectedId === plugin.id) setSelectedId(null);
      await loadPlugins();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const addScheduledTask = async (plugin: PluginInfo, task: PluginScheduledTask) => {
    const key = `${plugin.id}:${task.key}`;
    setBusyKey(key);
    setError(null);
    try {
      await codexApi.addPluginScheduledTask(
        plugin.name,
        plugin.marketplacePath,
        plugin.remoteMarketplaceName,
        task.key,
        defaultProjectId,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const openWebsite = async (url: string) => {
    try {
      await openUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const renderPluginDetail = (plugin: PluginInfo) => {
    const busy = busyKey === plugin.id;
    const detail = selectedDetail;
    const tasks = detail?.scheduledTasks ?? [];
    const skillsList = detail?.skills ?? [];
    const hooks = detail?.hooks ?? [];
    const mcp = detail?.mcpServers ?? [];
    const shots =
      plugin.screenshotUrls?.length
        ? plugin.screenshotUrls
        : (plugin.screenshots ?? []).map((p) => {
            try {
              return convertFileSrc(p);
            } catch {
              return p;
            }
          });
    const longText =
      plugin.longDescription || detail?.description || plugin.description || '';

    return (
      <div className="plugin-detail">
        <button
          type="button"
          className="btn btn-ghost plugin-detail-back"
          onClick={() => setSelectedId(null)}
        >
          ← 返回列表
        </button>

        <header className="plugin-detail-head">
          <PluginAvatar plugin={plugin} size={56} />
          <div className="plugin-detail-head-text">
            <h1>{plugin.displayName || plugin.name}</h1>
            <div className="plugin-detail-meta">
              {plugin.installed && <span className="ext-badge">已安装</span>}
              {plugin.version && (
                <span className="ext-badge muted">v{plugin.version}</span>
              )}
              {plugin.category && (
                <span className="ext-badge muted">{plugin.category}</span>
              )}
              {plugin.marketplaceName && (
                <span className="form-hint">{plugin.marketplaceName}</span>
              )}
            </div>
            {plugin.developerName && (
              <div className="form-hint">开发者 · {plugin.developerName}</div>
            )}
          </div>
          <div className="plugin-detail-actions">
            {plugin.websiteUrl && (
              <button
                type="button"
                className="icon-btn"
                title="网站"
                onClick={() => void openWebsite(plugin.websiteUrl!)}
              >
                <IconExternal />
              </button>
            )}
            {plugin.installed ? (
              <button
                type="button"
                className="icon-btn"
                title={busy ? '卸载中…' : '卸载'}
                disabled={busy}
                onClick={() => void uninstallPlugin(plugin)}
              >
                <IconTrash />
              </button>
            ) : (
              <button
                type="button"
                className="icon-btn"
                title={busy ? '安装中…' : '安装'}
                disabled={busy}
                onClick={() => void installPlugin(plugin)}
              >
                <IconDownload />
              </button>
            )}
          </div>
        </header>

        {error && <div className="error-banner">{error}</div>}
        {detailLoading && !detail && <div className="empty-hint">加载详情…</div>}

        {longText && (
          <section className="plugin-detail-section">
            <h2>介绍</h2>
            <p className="plugin-detail-prose">{longText}</p>
          </section>
        )}

        {(plugin.capabilities?.length ?? 0) > 0 && (
          <section className="plugin-detail-section">
            <h2>能力</h2>
            <div className="plugin-chip-row">
              {plugin.capabilities!.map((c) => (
                <span key={c} className="ext-badge muted">
                  {c}
                </span>
              ))}
            </div>
          </section>
        )}

        {(plugin.defaultPrompts?.length ?? 0) > 0 && (
          <section className="plugin-detail-section">
            <h2>开场提示</h2>
            <ul className="plugin-detail-list">
              {plugin.defaultPrompts!.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </section>
        )}

        {shots.length > 0 && (
          <section className="plugin-detail-section">
            <h2>截图</h2>
            <div className="plugin-shot-row">
              {shots.map((src) => (
                <img key={src} src={src} alt="" className="plugin-shot" />
              ))}
            </div>
          </section>
        )}

        {detail && (
          <>
            {skillsList.length > 0 && (
              <section className="plugin-detail-section">
                <h2>Skills（{skillsList.length}）</h2>
                <ul className="plugin-detail-list">
                  {skillsList.map((s, i) => (
                    <li key={s.path || s.name || i}>
                      <strong>{s.displayName || s.name || 'Skill'}</strong>
                      {s.description ? (
                        <span className="form-hint"> — {s.description}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {hooks.length > 0 && (
              <section className="plugin-detail-section">
                <h2>Hooks（{hooks.length}）</h2>
                <ul className="plugin-detail-list">
                  {hooks.map((h) => (
                    <li key={h.key}>
                      {h.eventName}
                      <span className="form-hint"> · {h.key}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {mcp.length > 0 && (
              <section className="plugin-detail-section">
                <h2>MCP（{mcp.length}）</h2>
                <ul className="plugin-detail-list">
                  {mcp.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </section>
            )}

            {plugin.installed && tasks.length > 0 && (
              <section className="plugin-detail-section">
                <h2>定时模板</h2>
                <ul className="ext-list">
                  {tasks.map((task) => {
                    const tBusy = busyKey === `${plugin.id}:${task.key}`;
                    return (
                      <li key={task.key} className="ext-item">
                        <div className="ext-item-body">
                          <div className="ext-item-title">{task.name}</div>
                          <div className="ext-item-desc">
                            {task.schedule?.type}
                            {task.schedule?.time ? ` @ ${task.schedule.time}` : ''}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={tBusy}
                          onClick={() => void addScheduledTask(plugin, task)}
                        >
                          {tBusy ? '添加中…' : '添加到已安排'}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    );
  };

  const renderSkillDetail = (skill: SkillInfo) => {
    const key = skillKey(skill);
    const busy = busyKey === key;
    const deps = skill.dependencies ?? [];
    return (
      <div className="plugin-detail">
        <button
          type="button"
          className="btn btn-ghost plugin-detail-back"
          onClick={() => setSelectedSkillKey(null)}
        >
          ← 返回列表
        </button>

        <header className="plugin-detail-head">
          <SkillAvatar skill={skill} size={56} large />
          <div className="plugin-detail-head-text">
            <h1>{skill.displayName || skill.name}</h1>
            <div className="plugin-detail-meta">
              <span className="ext-badge">{scopeLabel(skill.scope)}</span>
              <span className={`ext-badge ${skill.enabled ? '' : 'muted'}`}>
                {skill.enabled ? '已启用' : '已禁用'}
              </span>
            </div>
            {skill.name !== (skill.displayName || skill.name) && (
              <div className="form-hint">{skill.name}</div>
            )}
          </div>
          <div className="plugin-detail-actions">
            <label className="ext-switch">
              <input
                type="checkbox"
                checked={skill.enabled}
                disabled={busy}
                onChange={(e) => void toggleSkill(skill, e.target.checked)}
              />
              <span>{skill.enabled ? '已启用' : '已禁用'}</span>
            </label>
          </div>
        </header>

        {error && <div className="error-banner">{error}</div>}

        {(skill.shortDescription || skill.description) && (
          <section className="plugin-detail-section">
            <h2>介绍</h2>
            {skill.shortDescription && skill.description && skill.shortDescription !== skill.description && (
              <p className="plugin-detail-prose" style={{ marginBottom: 8 }}>
                {skill.shortDescription}
              </p>
            )}
            <p className="plugin-detail-prose">
              {skill.description || skill.shortDescription}
            </p>
          </section>
        )}

        {skill.defaultPrompt && (
          <section className="plugin-detail-section">
            <h2>开场提示</h2>
            <p className="plugin-detail-prose">{skill.defaultPrompt}</p>
          </section>
        )}

        {deps.length > 0 && (
          <section className="plugin-detail-section">
            <h2>依赖（{deps.length}）</h2>
            <ul className="plugin-detail-list">
              {deps.map((d, i) => (
                <li key={`${d.type}:${d.value}:${i}`}>
                  <strong>{d.value}</strong>
                  <span className="form-hint">
                    {' '}
                    · {d.type}
                    {d.command ? ` · ${d.command}` : ''}
                    {d.url ? ` · ${d.url}` : ''}
                  </span>
                  {d.description ? (
                    <div className="form-hint">{d.description}</div>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        )}

        {(skill.path || skill.cwd) && (
          <section className="plugin-detail-section">
            <h2>位置</h2>
            <ul className="plugin-detail-list">
              {skill.path ? <li>{skill.path}</li> : null}
              {skill.cwd ? <li>工作区 · {skill.cwd}</li> : null}
            </ul>
          </section>
        )}
      </div>
    );
  };

  return (
    <div className="settings-page">
      <aside className="settings-nav">
        <button type="button" className="settings-back" onClick={onClose}>
          ← 返回应用
        </button>
        <div className="settings-search">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={section === 'skills' ? '搜索 Skills…' : '搜索插件…'}
          />
        </div>
        <div className="settings-nav-group">
          <div className="settings-nav-group-label">扩展</div>
          <button
            type="button"
            className={`settings-nav-item ${section === 'skills' ? 'active' : ''}`}
            onClick={() => setSection('skills')}
          >
            <span className="settings-nav-icon">
              <IconSpark />
            </span>
            Skills
          </button>
          <button
            type="button"
            className={`settings-nav-item ${section === 'plugins' ? 'active' : ''}`}
            onClick={() => setSection('plugins')}
          >
            <span className="settings-nav-icon">
              <IconAt />
            </span>
            插件
          </button>
        </div>
      </aside>

      <main className="settings-main">
        {section === 'skills' && selectedSkill && renderSkillDetail(selectedSkill)}

        {section === 'skills' && !selectedSkill && (
          <>
            <header className="settings-main-head">
              <div className="archived-section-head">
                <div>
                  <h1>Skills</h1>
                  <p>启用或禁用本地可用的 Skills。点击查看详情。</p>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  title="刷新"
                  onClick={() => void loadSkills(true)}
                  disabled={loading}
                >
                  <IconRefresh />
                </button>
              </div>
            </header>
            {error && <div className="error-banner">{error}</div>}
            {loading && !filteredSkills.length ? (
              <div className="empty-hint">加载中…</div>
            ) : !filteredSkills.length ? (
              <div className="empty-hint">没有可用 Skills</div>
            ) : (
              <ul className="ext-list">
                {filteredSkills.map((skill) => {
                  const key = skillKey(skill);
                  const busy = busyKey === key;
                  return (
                    <li key={key} className="ext-item plugin-row">
                      <button
                        type="button"
                        className="plugin-row-main"
                        onClick={() => setSelectedSkillKey(key)}
                      >
                        <SkillAvatar skill={skill} size={40} />
                        <div className="ext-item-body">
                          <div className="ext-item-title">
                            {skill.displayName || skill.name}
                            <span className="ext-badge">{scopeLabel(skill.scope)}</span>
                          </div>
                          <div className="ext-item-desc">
                            {skill.shortDescription || skill.description || skill.path}
                          </div>
                        </div>
                      </button>
                      <div className="plugin-row-actions">
                        <label
                          className="ext-switch"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={skill.enabled}
                            disabled={busy}
                            onChange={(e) => void toggleSkill(skill, e.target.checked)}
                          />
                          <span>{skill.enabled ? '已启用' : '已禁用'}</span>
                        </label>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}

        {section === 'plugins' && selectedPlugin && renderPluginDetail(selectedPlugin)}

        {section === 'plugins' && !selectedPlugin && (
          <>
            <header className="settings-main-head">
              <div className="archived-section-head">
                <div>
                  <h1>插件</h1>
                  <p>浏览本机与市场源中的插件，点击查看详情。</p>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  title="刷新"
                  onClick={() => void loadPlugins()}
                  disabled={loading}
                >
                  <IconRefresh />
                </button>
              </div>
            </header>
            {error && <div className="error-banner">{error}</div>}
            {loading && !filteredPlugins.length ? (
              <div className="empty-hint">加载中…</div>
            ) : !filteredPlugins.length ? (
              <div className="empty-hint">没有可用插件</div>
            ) : (
              <ul className="ext-list">
                {filteredPlugins.map((plugin) => {
                  const busy = busyKey === plugin.id;
                  const cached = detailById[plugin.id];
                  const hasTasks = (cached?.scheduledTasks?.length ?? 0) > 0;
                  return (
                    <li key={plugin.id} className="ext-item plugin-row">
                      <button
                        type="button"
                        className="plugin-row-main"
                        onClick={() => openDetail(plugin)}
                      >
                        <PluginAvatar plugin={plugin} size={40} />
                        <div className="ext-item-body">
                          <div className="ext-item-title">
                            {plugin.displayName || plugin.name}
                            {plugin.installed && <span className="ext-badge">已安装</span>}
                            {plugin.version && (
                              <span className="ext-badge muted">v{plugin.version}</span>
                            )}
                            {plugin.category && (
                              <span className="ext-badge muted">{plugin.category}</span>
                            )}
                            {hasTasks && (
                              <span className="ext-badge muted">定时模板</span>
                            )}
                          </div>
                          <div className="ext-item-desc">
                            {plugin.description ||
                              plugin.marketplaceName ||
                              '无描述'}
                          </div>
                        </div>
                      </button>
                      <div className="plugin-row-actions">
                        {plugin.installed ? (
                          <button
                            type="button"
                            className="icon-btn"
                            title={busy ? '卸载中…' : '卸载'}
                            disabled={busy}
                            onClick={(e) => {
                              e.stopPropagation();
                              void uninstallPlugin(plugin);
                            }}
                          >
                            <IconTrash />
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="icon-btn"
                            title={busy ? '安装中…' : '安装'}
                            disabled={busy}
                            onClick={(e) => {
                              e.stopPropagation();
                              void installPlugin(plugin);
                            }}
                          >
                            <IconDownload />
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </main>
    </div>
  );
}

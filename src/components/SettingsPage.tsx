import { useEffect, useMemo, useState } from 'react';
import { ask } from '@tauri-apps/plugin-dialog';
import { SettingsForm } from './SettingsForm';
import { DynamicToolsSettingsPane } from './DynamicToolsSettingsPane';
import { AppServerSettingsPane } from './AppServerSettingsPane';
import { McpSettingsPane } from './McpSettingsPane';
import { codexApi } from '../api';
import type { AppSettings, Session } from '../types';

type SettingsSection = 'general' | 'appServer' | 'mcp' | 'desktopTools' | 'archived';

interface NavItem {
  id: SettingsSection;
  label: string;
  icon: 'gear' | 'tools' | 'archive' | 'server' | 'mcp';
}

interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    id: 'personal',
    label: '个人',
    items: [
      { id: 'general', label: '常规', icon: 'gear' },
      { id: 'appServer', label: 'App Server', icon: 'server' },
      { id: 'mcp', label: 'MCP', icon: 'mcp' },
      { id: 'desktopTools', label: '桌面工具', icon: 'tools' },
    ],
  },
  {
    id: 'archived',
    label: '已归档',
    items: [{ id: 'archived', label: '已归档的聊天', icon: 'archive' }],
  },
];

function IconGear() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

function IconTools() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

function IconArchive() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
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

function IconSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

function IconServer() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="4" width="18" height="6" rx="1" />
      <rect x="3" y="14" width="18" height="6" rx="1" />
      <path d="M7 7h.01M7 17h.01" />
    </svg>
  );
}

function IconMcp() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M8 6h8v4H8zM8 14h8v4H8z" />
      <path d="M12 10v4M6 8H4M6 16H4M20 8h-2M20 16h-2" />
    </svg>
  );
}

function NavIcon({ icon }: { icon: NavItem['icon'] }) {
  if (icon === 'archive') return <IconArchive />;
  if (icon === 'tools') return <IconTools />;
  if (icon === 'server') return <IconServer />;
  if (icon === 'mcp') return <IconMcp />;
  return <IconGear />;
}

interface Props {
  initial: Partial<AppSettings>;
  onSubmit: (settings: AppSettings) => Promise<{ ok: true } | { ok: false; error: string }>;
  onClose: () => void;
  onUnarchiveSession: (id: string) => Promise<void>;
  onDeleteSession: (id: string) => Promise<void>;
}

export function SettingsPage({
  initial,
  onSubmit,
  onClose,
  onUnarchiveSession,
  onDeleteSession,
}: Props) {
  const [section, setSection] = useState<SettingsSection>('general');
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState<Session[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [archivedError, setArchivedError] = useState<string | null>(null);
  const [unarchivingId, setUnarchivingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return NAV_GROUPS;
    return NAV_GROUPS.map((g) => ({
      ...g,
      items: g.items.filter((item) => item.label.toLowerCase().includes(q) || g.label.toLowerCase().includes(q)),
    })).filter((g) => g.items.length);
  }, [query]);

  const loadArchived = async () => {
    setArchivedLoading(true);
    setArchivedError(null);
    try {
      setArchived(await codexApi.listArchivedSessions());
    } catch (err) {
      setArchivedError(err instanceof Error ? err.message : String(err));
    } finally {
      setArchivedLoading(false);
    }
  };

  useEffect(() => {
    if (section !== 'archived') return;
    void loadArchived();
  }, [section]);

  const handleUnarchive = async (id: string) => {
    setUnarchivingId(id);
    setArchivedError(null);
    try {
      await onUnarchiveSession(id);
      setArchived((list) => list.filter((s) => s.id !== id));
    } catch (err) {
      setArchivedError(err instanceof Error ? err.message : String(err));
    } finally {
      setUnarchivingId(null);
    }
  };

  const handleDelete = async (s: Session) => {
    const ok = await ask(`删除会话「${s.title || '新对话'}」？此操作不可恢复。`, {
      title: '删除会话',
      kind: 'warning',
    });
    if (!ok) return;
    setDeletingId(s.id);
    setArchivedError(null);
    try {
      await onDeleteSession(s.id);
      setArchived((list) => list.filter((item) => s.id !== item.id));
    } catch (err) {
      setArchivedError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="settings-page">
      <aside className="settings-nav">
        <button type="button" className="settings-back" onClick={onClose}>
          ← 返回应用
        </button>
        <div className="settings-search">
          <span className="settings-search-icon">
            <IconSearch />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索设置…"
          />
        </div>
        {groups.map((g) => (
          <div key={g.id} className="settings-nav-group">
            <div className="settings-nav-group-label">{g.label}</div>
            {g.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`settings-nav-item ${section === item.id ? 'active' : ''}`}
                onClick={() => setSection(item.id)}
              >
                <span className="settings-nav-icon">
                  <NavIcon icon={item.icon} />
                </span>
                {item.label}
              </button>
            ))}
          </div>
        ))}
        {!groups.length && <div className="empty-hint">没有匹配的设置项</div>}
      </aside>

      <main className="settings-main">
        {section === 'general' && (
          <>
            <header className="settings-main-head">
              <h1>常规</h1>
              <p>修改 Provider 与模型，不会改变「项目 → 会话」组织方式。</p>
            </header>
            <SettingsForm
              embedded
              initial={initial}
              submitLabel="保存"
              onSubmit={onSubmit}
            />
          </>
        )}

        {section === 'appServer' && <AppServerSettingsPane />}

        {section === 'mcp' && <McpSettingsPane />}

        {section === 'desktopTools' && <DynamicToolsSettingsPane />}

        {section === 'archived' && (
          <>
            <header className="settings-main-head">
              <div className="archived-section-head">
                <div>
                  <h1>已归档的聊天</h1>
                  <p>归档会话不出现在侧边栏。取消归档后会回到「最近」或对应项目。</p>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void loadArchived()}
                  disabled={archivedLoading}
                >
                  刷新
                </button>
              </div>
            </header>
            {archivedError && <div className="error-banner">{archivedError}</div>}
            {archivedLoading && !archived.length ? (
              <div className="empty-hint">加载中…</div>
            ) : !archived.length ? (
              <div className="empty-hint">没有已归档会话</div>
            ) : (
              <ul className="archived-list">
                {archived.map((s) => (
                  <li key={s.id} className="archived-item">
                    <span className="archived-title" title={s.title}>
                      {s.title || '新对话'}
                    </span>
                    <button
                      type="button"
                      className="icon-btn archived-delete"
                      title="删除"
                      disabled={deletingId === s.id || unarchivingId === s.id}
                      onClick={() => void handleDelete(s)}
                    >
                      <IconTrash />
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={unarchivingId === s.id || deletingId === s.id}
                      onClick={() => void handleUnarchive(s.id)}
                    >
                      {unarchivingId === s.id ? '恢复中…' : '取消归档'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </main>
    </div>
  );
}

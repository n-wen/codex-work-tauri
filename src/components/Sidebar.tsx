import { useEffect, useMemo, useRef, useState } from 'react';
import { ask } from '@tauri-apps/plugin-dialog';
import { openPath } from '@tauri-apps/plugin-opener';
import { codexApi } from '../api';
import type { Project, Session, ThreadStatus, ThreadTokenUsage } from '../types';
import { CreateProjectDialog } from './CreateProjectDialog';
import { SessionActionsMenu } from './SessionActionsMenu';

interface Props {
  projects: Project[];
  sessions: Session[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  modelLabel?: string;
  tokenUsageByThread?: Record<string, ThreadTokenUsage>;
  onSelectProject: (id: string) => void;
  onSelectSession: (id: string) => void;
  onCreateProject: (name: string, workDir: string) => Promise<void>;
  onRenameProject: (id: string, name: string) => Promise<void>;
  onDeleteProject: (id: string) => Promise<void>;
  onArchiveProjectSessions: (id: string) => Promise<void>;
  /** null = ungrouped; string = under that project. Does not create session until first send. */
  onStartNewChat: (projectId?: string | null) => void;
  onRenameSession: (id: string, title: string) => Promise<void>;
  onArchiveSession: (id: string) => Promise<void>;
  onForkSession: (id: string) => Promise<void>;
  onReviewUncommitted?: (sessionId: string) => Promise<void>;
  onSearchSessions: (term: string) => Promise<Session[]>;
  onOpenSettings: () => void;
  onOpenPlugins: () => void;
  onOpenScheduled: () => void;
  selectDirectory: () => Promise<string | null>;
  onRefresh?: () => void;
}

function IconNewChat() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}

function IconClock() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function IconAt() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a9 9 0 1 0-3.5 7.2" />
    </svg>
  );
}

function IconFolder() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M21 12a9 9 0 1 1-2.6-6.2" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function IconMore() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}

function sessionStatusMeta(status?: ThreadStatus): { className: string; title: string } | null {
  if (!status || status.type === 'idle' || status.type === 'notLoaded') return null;
  if (status.type === 'systemError') {
    return { className: 'error', title: '出错' };
  }
  const flags = status.activeFlags ?? [];
  if (flags.includes('waitingOnApproval')) {
    return { className: 'waiting', title: '待审批' };
  }
  if (flags.includes('waitingOnUserInput')) {
    return { className: 'waiting', title: '等待输入' };
  }
  return { className: 'active', title: '运行中' };
}

function SessionRow({
  session,
  active,
  menuOpen,
  tokenUsage,
  onSelect,
  onOpenChange,
  onRename,
  onArchive,
  onFork,
  onReview,
}: {
  session: Session;
  active: boolean;
  menuOpen: boolean;
  tokenUsage?: ThreadTokenUsage | null;
  onSelect: () => void;
  onOpenChange: (open: boolean) => void;
  onRename: (title: string) => void;
  onArchive: () => void;
  onFork: () => void;
  onReview?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title || '新对话');
  const inputRef = useRef<HTMLInputElement>(null);
  const statusMeta = sessionStatusMeta(session.status);

  useEffect(() => {
    if (!editing) {
      setDraft(session.title || '新对话');
    }
  }, [session.title, editing]);

  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editing]);

  const commitRename = () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === (session.title || '新对话')) return;
    onRename(next);
  };

  if (editing) {
    return (
      <div className={`session-row ${active ? 'active' : ''} editing`}>
        <input
          ref={inputRef}
          className="session-rename-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitRename();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setDraft(session.title || '新对话');
              setEditing(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className={`session-row ${active ? 'active' : ''} ${menuOpen ? 'menu-open' : ''}`}>
      <button type="button" className="session-row-main" onClick={onSelect} title={session.title || '新对话'}>
        {statusMeta ? (
          <span
            className={`session-status-dot ${statusMeta.className}`}
            title={statusMeta.title}
            aria-label={statusMeta.title}
          />
        ) : null}
        <span className="session-title-text">{session.title || '新对话'}</span>
      </button>
      <div className={`session-row-actions ${menuOpen ? 'open' : ''}`}>
        <SessionActionsMenu
          sessionId={session.id}
          title={session.title || '新对话'}
          tokenUsage={tokenUsage}
          open={menuOpen}
          onOpenChange={onOpenChange}
          onRename={() => {
            setDraft(session.title || '新对话');
            setEditing(true);
          }}
          onArchive={onArchive}
          onFork={onFork}
          onReview={onReview}
        />
      </div>
    </div>
  );
}

export function Sidebar({
  projects,
  sessions,
  activeProjectId,
  activeSessionId,
  modelLabel,
  tokenUsageByThread = {},
  onSelectProject,
  onSelectSession,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onArchiveProjectSessions,
  onStartNewChat,
  onRenameSession,
  onArchiveSession,
  onForkSession,
  onReviewUncommitted,
  onSearchSessions,
  onOpenSettings,
  onOpenPlugins,
  onOpenScheduled,
  selectDirectory,
  onRefresh,
}: Props) {
  const [showCreate, setShowCreate] = useState(false);
  const [query, setQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [searchHits, setSearchHits] = useState<Session[] | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null);
  const [menuSessionId, setMenuSessionId] = useState<string | null>(null);
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [projectRenameDraft, setProjectRenameDraft] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const projectRenameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!menuProjectId) return;
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuProjectId(null);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [menuProjectId]);

  useEffect(() => {
    if (!renamingProjectId) return;
    const el = projectRenameRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [renamingProjectId]);

  useEffect(() => {
    const term = query.trim();
    if (!showSearch || !term) {
      setSearchHits(null);
      setSearchBusy(false);
      return;
    }
    let cancelled = false;
    setSearchBusy(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const hits = await onSearchSessions(term);
          if (!cancelled) setSearchHits(hits);
        } catch {
          if (!cancelled) setSearchHits([]);
        } finally {
          if (!cancelled) setSearchBusy(false);
        }
      })();
    }, 280);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, showSearch, onSearchSessions]);

  const recentSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q && searchHits) {
      return [...searchHits].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    }
    const list = [...sessions].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    if (!q) return list;
    return list.filter((s) => s.title.toLowerCase().includes(q));
  }, [sessions, query, searchHits]);
  const projectSessions = useMemo(() => {
    if (!activeProjectId) return [];
    return sessions.filter((s) => s.projectId === activeProjectId);
  }, [sessions, activeProjectId]);

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="sidebar-top-actions">
          <button
            type="button"
            className="icon-btn"
            title="刷新"
            onClick={() => onRefresh?.()}
          >
            <IconRefresh />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="搜索"
            onClick={() => setShowSearch((v) => !v)}
          >
            <IconSearch />
          </button>
        </div>
      </div>

      {showSearch && (
        <div className="create-row" style={{ margin: '0 4px 10px' }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchBusy ? '搜索中…' : '搜索会话…'}
            autoFocus
          />
        </div>
      )}

      <div className="sidebar-nav">
        <button
          type="button"
          className="nav-item"
          onClick={() => onStartNewChat(null)}
          title="新对话"
        >
          <span className="nav-icon">
            <IconNewChat />
          </span>
          新对话
        </button>
        <button type="button" className="nav-item" onClick={onOpenScheduled} title="已安排">
          <span className="nav-icon">
            <IconClock />
          </span>
          已安排
        </button>
        <button type="button" className="nav-item" onClick={onOpenPlugins} title="插件与 Skills">
          <span className="nav-icon">
            <IconAt />
          </span>
          插件
        </button>
      </div>

      <div className="sidebar-scroll">
        <div className="section-label">
          <span>项目</span>
          <button type="button" onClick={() => setShowCreate(true)}>
            添加
          </button>
        </div>

        {projects.map((p) => {
          const open = p.id === activeProjectId;
          const menuOpen = menuProjectId === p.id;
          const renaming = renamingProjectId === p.id;
          const commitProjectRename = () => {
            const next = projectRenameDraft.trim();
            setRenamingProjectId(null);
            if (!next || next === p.name) return;
            void onRenameProject(p.id, next);
          };
          return (
            <div key={p.id} className="project-block">
              <div className={`project-row ${open ? 'active' : ''} ${menuOpen ? 'menu-open' : ''}`}>
                {renaming ? (
                  <input
                    ref={projectRenameRef}
                    className="session-rename-input"
                    value={projectRenameDraft}
                    onChange={(e) => setProjectRenameDraft(e.target.value)}
                    onBlur={commitProjectRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitProjectRename();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setRenamingProjectId(null);
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="project-row-main"
                    onClick={() => onSelectProject(p.id)}
                    title={p.workDir}
                  >
                    <span className="folder-icon">
                      <IconFolder />
                    </span>
                    <span className="title">{p.name}</span>
                  </button>
                )}
                {!renaming && (
                <div className={`project-row-actions ${menuOpen ? 'open' : ''}`}>
                  <div className="project-menu" ref={menuOpen ? menuRef : undefined}>
                    <button
                      type="button"
                      className="icon-btn project-action"
                      title="配置"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuSessionId(null);
                        setMenuProjectId((cur) => (cur === p.id ? null : p.id));
                      }}
                    >
                      <IconMore />
                    </button>
                    {menuOpen && (
                      <div className="dropdown-menu">
                        <button
                          type="button"
                          className="dropdown-item"
                          disabled={!p.workDir}
                          onClick={() => {
                            setMenuProjectId(null);
                            if (!p.workDir) return;
                            void openPath(p.workDir);
                          }}
                        >
                          在资源管理器中打开
                        </button>
                        <button
                          type="button"
                          className="dropdown-item"
                          disabled={!p.workDir}
                          onClick={() => {
                            setMenuProjectId(null);
                            if (!p.workDir) return;
                            void codexApi.openInEditor(p.workDir).catch((err) => {
                              window.alert(err instanceof Error ? err.message : String(err));
                            });
                          }}
                        >
                          用 VS Code 打开
                        </button>
                        <button
                          type="button"
                          className="dropdown-item"
                          onClick={() => {
                            setMenuProjectId(null);
                            setProjectRenameDraft(p.name);
                            setRenamingProjectId(p.id);
                          }}
                        >
                          编辑项目
                        </button>
                        <button
                          type="button"
                          className="dropdown-item"
                          disabled={!sessions.some((s) => s.projectId === p.id)}
                          onClick={() => {
                            setMenuProjectId(null);
                            const count = sessions.filter((s) => s.projectId === p.id).length;
                            if (!count) return;
                            void (async () => {
                              const ok = await ask(
                                `归档项目「${p.name}」下的 ${count} 条会话？可在设置「已归档的聊天」中恢复。`,
                                { title: '归档全部会话', kind: 'warning' },
                              );
                              if (ok) await onArchiveProjectSessions(p.id);
                            })();
                          }}
                        >
                          归档全部会话
                        </button>
                        <button
                          type="button"
                          className="dropdown-item danger"
                          onClick={() => {
                            setMenuProjectId(null);
                            void (async () => {
                              const ok = await ask(
                                `删除项目「${p.name}」？会话仍保留在 Codex，会出现在「最近」。本地文件不会删除。`,
                                { title: '删除项目', kind: 'warning' },
                              );
                              if (ok) void onDeleteProject(p.id);
                            })();
                          }}
                        >
                          删除
                        </button>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="icon-btn project-action"
                    title="新对话"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuProjectId(null);
                      setMenuSessionId(null);
                      onStartNewChat(p.id);
                    }}
                  >
                    <IconNewChat />
                  </button>
                </div>
                )}
              </div>
              {open && (
                <div className="session-list">
                  {projectSessions.map((s) => {
                    const menuKey = `project:${s.id}`;
                    return (
                      <SessionRow
                        key={s.id}
                        session={s}
                        active={s.id === activeSessionId}
                        menuOpen={menuSessionId === menuKey}
                        tokenUsage={tokenUsageByThread[s.id] ?? null}
                        onSelect={() => {
                          setMenuProjectId(null);
                          setMenuSessionId(null);
                          onSelectSession(s.id);
                        }}
                        onOpenChange={(open) => {
                          setMenuProjectId(null);
                          setMenuSessionId(open ? menuKey : null);
                        }}
                        onRename={(title) => void onRenameSession(s.id, title)}
                        onArchive={() => void onArchiveSession(s.id)}
                        onFork={() => void onForkSession(s.id)}
                        onReview={
                          onReviewUncommitted
                            ? () => void onReviewUncommitted(s.id)
                            : undefined
                        }
                      />
                    );
                  })}
                  {!projectSessions.length && (
                    <div className="empty-hint">暂无会话，点「新对话」开始</div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {!projects.length && <div className="empty-hint">没有项目</div>}

        <div className="section-label">
          <span>最近</span>
        </div>
        <div className="recent-list">
          {recentSessions.map((s) => {
            const menuKey = `recent:${s.id}`;
            return (
              <SessionRow
                key={`recent-${s.id}`}
                session={s}
                active={s.id === activeSessionId}
                menuOpen={menuSessionId === menuKey}
                tokenUsage={tokenUsageByThread[s.id] ?? null}
                onSelect={() => {
                  setMenuProjectId(null);
                  setMenuSessionId(null);
                  onSelectSession(s.id);
                }}
                onOpenChange={(open) => {
                  setMenuProjectId(null);
                  setMenuSessionId(open ? menuKey : null);
                }}
                onRename={(title) => void onRenameSession(s.id, title)}
                onArchive={() => void onArchiveSession(s.id)}
                onFork={() => void onForkSession(s.id)}
                onReview={
                  onReviewUncommitted
                    ? () => void onReviewUncommitted(s.id)
                    : undefined
                }
              />
            );
          })}
          {!recentSessions.length && (
            <div className="empty-hint">还没有最近会话</div>
          )}
        </div>
      </div>

      <CreateProjectDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreate={onCreateProject}
        selectDirectory={selectDirectory}
      />

      <div className="sidebar-footer">
        <div className="user-avatar">CW</div>
        <div className="user-meta">
          <div className="name">Codex Work</div>
          <div className="sub" title={modelLabel}>
            {modelLabel || '本地'}
          </div>
        </div>
        <button type="button" className="icon-btn" title="设置" onClick={onOpenSettings}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </button>
      </div>
    </aside>
  );
}

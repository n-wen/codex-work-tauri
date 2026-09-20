import { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { convertFileSrc } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type {
  AgentPermissions,
  ChatMessage,
  GitStatus,
  ModelEntry,
  ProviderCapabilities,
  ReviewTarget,
  ThreadGoal,
  ThreadTokenUsage,
} from '../types';
import {
  PERMISSIONS_PRESETS,
  matchPermissionsPreset,
  permissionsLabel,
  contextWindowUsedRatio,
  tokensInContextWindow,
} from '../types';
import { ToolCard } from './ToolCard';
import { ContextUsagePopover } from './ContextUsagePopover';
import { SessionActionsMenu } from './SessionActionsMenu';
import { GitStatusPopover } from './GitStatusPopover';
import { codexApi } from '../api';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif']);
const MAX_IMAGES = 8;

function isImagePath(path: string): boolean {
  const base = path.split(/[\\/]/).pop() ?? path;
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
  return IMAGE_EXTS.has(ext);
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

interface Props {
  title: string;
  messages: ChatMessage[];
  streamingId: string | null;
  running: boolean;
  statusText: string;
  error: string | null;
  modelLabel?: string;
  models?: ModelEntry[];
  selectedModel?: string;
  onSelectModel?: (model: string) => void;
  onChangeProvider?: () => void;
  providerCaps?: ProviderCapabilities | null;
  effort?: string | null;
  onSelectEffort?: (effort: string) => void;
  focusKey?: number;
  permissions: AgentPermissions | null;
  permissionsBusy?: boolean;
  queueCount?: number;
  onPermissionsChange: (next: AgentPermissions) => Promise<void>;
  onSend: (
    text: string,
    images?: string[],
    extras?: {
      skills?: { name: string; path: string }[];
      mentions?: { name: string; path: string }[];
    },
  ) => Promise<void>;
  onInterrupt: () => Promise<void>;
  onInterruptAndClear?: () => Promise<void>;
  mentionRoots?: string[];
  skillCwds?: string[];
  workspacePath?: string | null;
  onCancelPending?: (id: string) => Promise<void>;
  onSendPendingNow?: (id: string) => Promise<void>;
  onForkFromTurn?: (turnId: string) => Promise<void>;
  turnDiff?: string | null;
  previewOpen?: boolean;
  onTogglePreview?: () => void;
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
  filesOpen?: boolean;
  onToggleFiles?: () => void;
  composerInsert?: { key: number; text: string } | null;
  sessionId?: string | null;
  goal?: ThreadGoal | null;
  tokenUsage?: ThreadTokenUsage | null;
  onSetGoal?: (objective: string) => Promise<void>;
  onClearGoal?: () => Promise<void>;
  onCompact?: () => Promise<void>;
  onRenameSession?: (title: string) => Promise<void>;
  onArchiveSession?: () => Promise<void>;
  onForkSession?: () => Promise<void>;
  onReview?: (target: ReviewTarget, delivery?: 'inline' | 'detached') => Promise<void>;
}

type AtKind = 'skill' | 'file';
interface AtItem {
  kind: AtKind;
  name: string;
  path: string;
  label: string;
}

interface SlashCommand {
  id: string;
  label: string;
  description: string;
  insert: string;
  /** If true, selecting runs immediately instead of inserting. */
  runOnPick?: boolean;
}

const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'goal',
    label: '/goal',
    description: '设置会话目标，例如 /goal 修好登录页',
    insert: '/goal ',
  },
  {
    id: 'goal-clear',
    label: '/goal clear',
    description: '清除当前会话目标',
    insert: '/goal clear',
    runOnPick: true,
  },
];

function matchSlashCommands(draft: string): SlashCommand[] | null {
  const m = /^\/([^\s]*)$/.exec(draft);
  if (!m) return null;
  const q = (m[1] ?? '').toLowerCase();
  const list = SLASH_COMMANDS.filter(
    (c) => !q || c.label.slice(1).toLowerCase().startsWith(q) || c.id.includes(q),
  );
  return list;
}

export function ChatArea({
  title,
  messages,
  streamingId,
  running,
  statusText,
  error,
  modelLabel,
  models = [],
  selectedModel,
  onSelectModel,
  onChangeProvider,
  providerCaps = null,
  effort = null,
  onSelectEffort,
  focusKey = 0,
  permissions,
  permissionsBusy = false,
  onPermissionsChange,
  queueCount = 0,
  onSend,
  onInterrupt,
  onInterruptAndClear,
  mentionRoots = [],
  skillCwds = [],
  workspacePath = null,
  onCancelPending,
  onSendPendingNow,
  onForkFromTurn,
  turnDiff = null,
  previewOpen = false,
  onTogglePreview,
  terminalOpen = false,
  onToggleTerminal,
  filesOpen = false,
  onToggleFiles,
  composerInsert,
  sessionId = null,
  goal = null,
  tokenUsage = null,
  onSetGoal,
  onClearGoal,
  onCompact,
  onRenameSession,
  onArchiveSession,
  onForkSession,
  onReview,
}: Props) {
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);
  const [atItems, setAtItems] = useState<AtItem[]>([]);
  const [atOpen, setAtOpen] = useState(false);
  const [atQuery, setAtQuery] = useState('');
  const [atSuggestions, setAtSuggestions] = useState<AtItem[]>([]);
  const [atIndex, setAtIndex] = useState(0);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashSuggestions, setSlashSuggestions] = useState<SlashCommand[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitOpen, setGitOpen] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [effortSubmenuOpen, setEffortSubmenuOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(true);
  const [contextOpen, setContextOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(title || '新对话');
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  const presetId = matchPermissionsPreset(permissions);
  const chipLabel = permissionsLabel(permissions);
  const currentModel =
    selectedModel ||
    models.find((m) => m.label === modelLabel)?.model ||
    models[0]?.model ||
    '';
  const currentModelLabel =
    models.find((m) => m.model === currentModel)?.label || modelLabel || '模型';
  const allowImages = providerCaps?.inputImages !== false;
  const effortOptions = providerCaps?.reasoningEfforts ?? [];
  const showEffort = effortOptions.length > 0;
  const currentEffort =
    effort ||
    providerCaps?.defaultReasoningEffort ||
    effortOptions[0]?.effort ||
    '';
  const currentEffortLabel =
    effortOptions.find((e) => e.effort === currentEffort)?.effort ||
    currentEffort ||
    'effort';
  const contextUsed = tokensInContextWindow(tokenUsage);
  const contextWindow = tokenUsage?.modelContextWindow ?? null;
  const contextPct = contextWindowUsedRatio(tokenUsage) ?? 0;
  const contextRingR = 6.2;
  const contextRingC = 2 * Math.PI * contextRingR;
  const contextRingColor =
    contextPct >= 0.9 ? '#ef4444' : contextPct >= 0.75 ? '#f59e0b' : 'currentColor';
  const contextTitle =
    contextWindow && contextWindow > 0
      ? `上下文 ${Math.round(contextPct * 100)}%（${contextUsed.toLocaleString()} / ${contextWindow.toLocaleString()}）`
      : '上下文用量';
  const queuedMessages = messages.filter((m) => m.queued);
  const visibleMessages = messages.filter((m) => !m.queued);

  useEffect(() => {
    if (!renaming) setRenameDraft(title || '新对话');
  }, [title, renaming]);

  useEffect(() => {
    if (!renaming) return;
    const el = renameInputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [renaming]);

  const commitHeaderRename = () => {
    const next = renameDraft.trim();
    setRenaming(false);
    if (!next || next === (title || '新对话') || !onRenameSession) return;
    void onRenameSession(next);
  };

  useEffect(() => {
    let cancelled = false;
    const path = workspacePath?.trim();
    if (!path) {
      setGitStatus(null);
      return;
    }
    const load = () => {
      void codexApi
        .getGitStatus(path)
        .then((s) => {
          if (!cancelled) setGitStatus(s);
        })
        .catch(() => {
          if (!cancelled) setGitStatus(null);
        });
    };
    load();
    const timer = window.setInterval(load, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [workspacePath]);

  const refreshGitStatus = () => {
    const path = workspacePath?.trim();
    if (!path) return;
    void codexApi.getGitStatus(path).then(setGitStatus).catch(() => setGitStatus(null));
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [visibleMessages, streamingId, queuedMessages.length]);

  useEffect(() => {
    if (queuedMessages.length > 0) setQueueOpen(true);
  }, [queuedMessages.length]);

  useEffect(() => {
    if (!focusKey) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    el.setSelectionRange(len, len);
  }, [focusKey]);

  useEffect(() => {
    if (!composerInsert) return;
    setDraft((prev) =>
      prev.trim() ? `${prev.replace(/\s+$/, '')}\n\n${composerInsert.text}` : composerInsert.text,
    );
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    });
  }, [composerInsert]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!modelMenuOpen) {
      setEffortSubmenuOpen(false);
      return;
    }
    const onPointer = (e: MouseEvent) => {
      if (!modelMenuRef.current?.contains(e.target as Node)) {
        setModelMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (effortSubmenuOpen) {
        setEffortSubmenuOpen(false);
        return;
      }
      setModelMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [modelMenuOpen, effortSubmenuOpen]);

  useEffect(() => {
    if (!contextOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (!contextMenuRef.current?.contains(e.target as Node)) {
        setContextOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [contextOpen]);

  useEffect(() => {
    if (!running) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'Backspace') {
        e.preventDefault();
        void onInterrupt();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [running, onInterrupt]);

  const addImagePaths = (paths: string[]) => {
    const images = paths.filter(isImagePath);
    if (!images.length) {
      if (paths.length) setAttachError('只能添加图片文件');
      return;
    }
    setAttachments((prev) => {
      const next = [...prev];
      for (const p of images) {
        if (next.includes(p)) continue;
        if (next.length >= MAX_IMAGES) {
          setAttachError(`最多 ${MAX_IMAGES} 张图`);
          break;
        }
        next.push(p);
      }
      return next;
    });
    if (images.length) setAttachError(null);
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === 'over') {
            setDragOver(true);
            return;
          }
          if (event.payload.type === 'leave') {
            setDragOver(false);
            return;
          }
          if (event.payload.type === 'drop') {
            setDragOver(false);
            addImagePaths(event.payload.paths ?? []);
          }
        });
      } catch {
        /* not in tauri webview */
      }
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  const pickImages = async () => {
    try {
      const selected = await open({
        multiple: true,
        title: '选择图片',
        filters: [
          {
            name: 'Images',
            extensions: Array.from(IMAGE_EXTS),
          },
        ],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      addImagePaths(paths);
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : String(err));
    }
  };

  const submit = async () => {
    const text = draft.trim();
    if (!text && !attachments.length && !atItems.length) return;

    // Slash commands: handled locally, never sent to the model.
    if (sessionId && text.startsWith('/')) {
      const clearMatch = /^\/goal\s+clear\s*$/i.test(text) || /^\/cleargoal\s*$/i.test(text);
      if (clearMatch) {
        setDraft('');
        setSlashOpen(false);
        setAttachError(null);
        if (!onClearGoal) {
          setAttachError('当前会话不支持清除目标');
          return;
        }
        try {
          await onClearGoal();
        } catch (e) {
          setAttachError(e instanceof Error ? e.message : String(e));
        }
        return;
      }
      const setMatch = /^\/goal(?:\s+)(.+)$/i.exec(text);
      if (setMatch) {
        const objective = (setMatch[1] ?? '').trim();
        if (!objective || /^clear$/i.test(objective)) {
          // fall through — clear already handled
        } else {
          setDraft('');
          setSlashOpen(false);
          setAttachError(null);
          if (!onSetGoal) {
            setAttachError('当前会话不支持设置目标');
            return;
          }
          try {
            await onSetGoal(objective);
          } catch (e) {
            setAttachError(e instanceof Error ? e.message : String(e));
          }
          return;
        }
      }
      if (/^\/goal\s*$/i.test(text)) {
        setAttachError('用法：/goal <目标内容>，或 /goal clear');
        return;
      }
    }

    const images = [...attachments];
    const skills = atItems
      .filter((a) => a.kind === 'skill')
      .map(({ name, path }) => ({ name, path }));
    const mentions = atItems
      .filter((a) => a.kind === 'file')
      .map(({ name, path }) => ({ name, path }));
    setDraft('');
    setAttachments([]);
    setAtItems([]);
    setAtOpen(false);
    setSlashOpen(false);
    setAttachError(null);
    await onSend(text, images, { skills, mentions });
  };

  const pickAtItem = (item: AtItem) => {
    setAtItems((prev) =>
      prev.some((p) => p.kind === item.kind && p.path === item.path)
        ? prev
        : [...prev, item],
    );
    // Remove trailing @query from draft.
    const at = draft.lastIndexOf('@');
    if (at >= 0) {
      setDraft(draft.slice(0, at));
    }
    setAtOpen(false);
    setAtQuery('');
    setAtSuggestions([]);
    textareaRef.current?.focus();
  };

  const pickSlashCommand = (cmd: SlashCommand) => {
    setSlashOpen(false);
    setSlashSuggestions([]);
    if (cmd.runOnPick) {
      setDraft('');
      setAttachError(null);
      void onClearGoal?.().catch((e) => {
        setAttachError(e instanceof Error ? e.message : String(e));
      });
      return;
    }
    setDraft(cmd.insert);
    textareaRef.current?.focus();
  };

  useEffect(() => {
    if (!atOpen) return;
    let cancelled = false;
    const sessionToken = `at-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const run = async () => {
      const q = atQuery.trim().toLowerCase();
      const out: AtItem[] = [];
      try {
        const skills = await codexApi.listSkills(skillCwds.length ? skillCwds : undefined, false);
        for (const s of skills.filter((x) => x.enabled !== false)) {
          const label = s.displayName || s.name;
          if (!q || label.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)) {
            out.push({
              kind: 'skill',
              name: s.name,
              path: s.path,
              label: `Skill · ${label}`,
            });
          }
        }
      } catch {
        /* ignore */
      }
      if (!cancelled) {
        setAtSuggestions(out.slice(0, 30));
        setAtIndex(0);
      }

      const roots = mentionRoots.filter((r) => r.trim());
      if (!roots.length || !atQuery.trim()) {
        return;
      }

      const mergeFiles = (files: { path?: string; fileName?: string }[]) => {
        if (cancelled) return;
        setAtSuggestions((prev) => {
          const skillsOnly = prev.filter((x) => x.kind === 'skill');
          const fileItems: AtItem[] = [];
          for (const f of files.slice(0, 20)) {
            const path = f.path;
            if (!path) continue;
            const name = f.fileName || path.split(/[\\/]/).pop() || path;
            fileItems.push({ kind: 'file', name, path, label: `文件 · ${name}` });
          }
          return [...skillsOnly, ...fileItems].slice(0, 30);
        });
        setAtIndex(0);
      };

      const off = codexApi.onEvent((ev) => {
        if (
          ev.method !== 'fuzzyFileSearch/sessionUpdated' &&
          ev.method !== 'fuzzyFileSearch/sessionCompleted'
        ) {
          return;
        }
        const sid = String(ev.params.sessionId ?? '');
        if (sid && sid !== sessionToken) return;
        const files = Array.isArray(ev.params.files) ? ev.params.files : [];
        mergeFiles(
          files.map((f) => {
            const row = f as { path?: string; file_name?: string; fileName?: string };
            return {
              path: row.path,
              fileName: row.fileName || row.file_name,
            };
          }),
        );
      });

      try {
        const res = await codexApi.fuzzyFileSearch(atQuery, roots, sessionToken);
        mergeFiles(res.files ?? []);
      } catch {
        /* ignore */
      } finally {
        off();
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [atOpen, atQuery, mentionRoots, skillCwds]);

  const onDraftChange = (value: string) => {
    setDraft(value);
    if (sessionId) {
      const slash = matchSlashCommands(value.trimStart());
      if (slash) {
        setSlashSuggestions(slash);
        setSlashOpen(slash.length > 0);
        setSlashIndex(0);
        setAtOpen(false);
        setAtQuery('');
        return;
      }
    }
    setSlashOpen(false);
    setSlashSuggestions([]);
    const caret = value; // approximate: scan end for @token
    const m = /(^|[\s])@([^\s@]*)$/.exec(caret);
    if (m) {
      setAtOpen(true);
      setAtQuery(m[2] ?? '');
    } else {
      setAtOpen(false);
      setAtQuery('');
    }
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  };

  const formatMessageTime = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  };

  const pickPreset = async (next: AgentPermissions) => {
    setMenuOpen(false);
    await onPermissionsChange(next);
  };

  return (
    <main className="main">
      <header className="session-header">
        <div className="session-title">
          {renaming ? (
            <input
              ref={renameInputRef}
              className="session-rename-input"
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onBlur={commitHeaderRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitHeaderRename();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setRenameDraft(title || '新对话');
                  setRenaming(false);
                }
              }}
            />
          ) : (
            <span>{title || '新对话'}</span>
          )}
          {gitStatus?.branch && (
            <span style={{ position: 'relative', marginLeft: 8, display: 'inline-flex' }}>
              <button
                type="button"
                className={`composer-chip${gitOpen ? ' active' : ''}`}
                title={gitStatus.dirty ? '工作区有未提交更改（点击查看）' : `分支 ${gitStatus.branch}`}
                onClick={() => setGitOpen((v) => !v)}
              >
                {gitStatus.branch}
                {gitStatus.dirty ? ' •' : ''}
                {gitStatus.ahead > 0 ? ` ↑${gitStatus.ahead}` : ''}
                {gitStatus.behind > 0 ? ` ↓${gitStatus.behind}` : ''}
              </button>
              {workspacePath && (
                <GitStatusPopover
                  cwd={workspacePath}
                  status={gitStatus}
                  open={gitOpen}
                  onClose={() => setGitOpen(false)}
                  onReview={onReview}
                  onStatusChange={refreshGitStatus}
                />
              )}
            </span>
          )}
          {sessionId && (
            <SessionActionsMenu
              sessionId={sessionId}
              title={title || '新对话'}
              tokenUsage={tokenUsage}
              triggerClassName="icon-btn"
              onRename={() => {
                setRenameDraft(title || '新对话');
                setRenaming(true);
              }}
              onArchive={() => void onArchiveSession?.()}
              onFork={() => void onForkSession?.()}
              onReview={
                onReview
                  ? () => void onReview({ type: 'uncommittedChanges' }, 'inline')
                  : undefined
              }
            />
          )}
        </div>
        <div className="session-header-actions">
          {sessionId && (
            <button
              type="button"
              className={`icon-btn${terminalOpen ? ' active' : ''}`}
              title={terminalOpen ? '隐藏终端' : '打开终端'}
              onClick={() => onToggleTerminal?.()}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <path d="M7 10l2.5 2L7 14" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M12 14h5" strokeLinecap="round" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className={`icon-btn${filesOpen ? ' active' : ''}`}
            title={filesOpen ? '关闭文件' : '打开文件'}
            onClick={() => onToggleFiles?.()}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10Z" />
            </svg>
          </button>
          <button
            type="button"
            className={`icon-btn${previewOpen ? ' active' : ''}`}
            title={previewOpen ? '关闭预览' : '打开预览'}
            onClick={() => onTogglePreview?.()}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M3 9h18" />
              <circle cx="6.5" cy="6.5" r="0.8" fill="currentColor" stroke="none" />
              <circle cx="9.2" cy="6.5" r="0.8" fill="currentColor" stroke="none" />
              <circle cx="11.9" cy="6.5" r="0.8" fill="currentColor" stroke="none" />
            </svg>
          </button>
        </div>
      </header>

      <div className="messages">
        {!visibleMessages.length && !queuedMessages.length && (
          <div className="empty-state">
            <h2>开始新对话</h2>
            <p>
              直接描述你想做的事。没有项目时会自动创建本地工作区；助手会流式回复并用工具操作当前目录。
            </p>
          </div>
        )}

        {visibleMessages.map((m) => (
          <div key={m.id} className={`message ${m.role}${m.kind ? ` kind-${m.kind}` : ''}`}>
            {m.kind === 'reasoning' ? (
              <details className="reasoning-block">
                <summary>思考</summary>
                <div className="reasoning-body">
                  {m.reasoningSummary || (streamingId === m.id ? '…' : '（无摘要）')}
                </div>
              </details>
            ) : m.kind === 'plan' ? (
              <details className="collapsible-card plan-card" open>
                <summary>计划</summary>
                <div className="collapsible-body">
                  {m.planExplanation && (
                    <p className="plan-explanation">{m.planExplanation}</p>
                  )}
                  <ul className="plan-steps">
                    {(m.planSteps ?? []).map((s, i) => (
                      <li key={`${s.step}-${i}`} className={`plan-step ${s.status}`}>
                        <span className="plan-step-status" aria-hidden>
                          {s.status === 'completed' ? '✓' : s.status === 'inProgress' ? '…' : '○'}
                        </span>
                        <span>{s.step}</span>
                      </li>
                    ))}
                  </ul>
                  {!m.planSteps?.length && <div className="empty-hint">暂无步骤</div>}
                </div>
              </details>
            ) : m.role === 'user' ? (
              <div className="message-user-wrap">
                {!!m.images?.length && (
                  <div className="message-attachments">
                    {m.images.map((path) => (
                      <img
                        key={path}
                        className="message-attach-thumb"
                        src={convertFileSrc(path)}
                        alt={fileName(path)}
                        title={path}
                      />
                    ))}
                  </div>
                )}
                {(m.content || !m.images?.length) && (
                  <div className="message-body">{m.content || '（无文本）'}</div>
                )}
                {m.delivery === 'pending' && (
                  <span className="msg-delivery pending" title="发送中" aria-label="发送中">
                    <svg className="msg-delivery-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                      <circle cx="12" cy="12" r="9" strokeOpacity="0.25" />
                      <path d="M21 12a9 9 0 0 0-9-9" strokeLinecap="round" />
                    </svg>
                    <span className="msg-delivery-label">发送中</span>
                  </span>
                )}
                {m.delivery === 'received' && (
                  <span className="msg-delivery received" title="已接收" aria-label="已接收">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                      <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span className="msg-delivery-label">已接收</span>
                  </span>
                )}
                {m.turnId && onForkFromTurn && !m.queued && m.delivery !== 'pending' && (
                  <div className="message-meta">
                    <div className="message-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        title="从此处分叉"
                        onClick={() => void onForkFromTurn(m.turnId!)}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <circle cx="6" cy="6" r="2.2" />
                          <circle cx="6" cy="18" r="2.2" />
                          <circle cx="18" cy="12" r="2.2" />
                          <path d="M8 7.5v9M8 12h7.5" strokeLinecap="round" />
                        </svg>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <>
                <div
                  className={`message-body ${streamingId === m.id ? 'streaming-cursor' : ''}`}
                >
                  {m.content || (streamingId === m.id ? '' : '（无文本）')}
                </div>
                {!!m.toolCalls?.length && (
                  <div className="tool-cards">
                    {m.toolCalls.map((t) => (
                      <ToolCard key={t.id} tool={t} />
                    ))}
                  </div>
                )}
                {(m.content && streamingId !== m.id) || m.createdAt ? (
                  <div className="message-meta">
                    {m.createdAt && (
                      <span className="message-time" title={new Date(m.createdAt).toLocaleString('zh-CN')}>
                        {formatMessageTime(m.createdAt)}
                      </span>
                    )}
                    {m.content && streamingId !== m.id && (
                      <div className="message-actions">
                        <button
                          type="button"
                          className="icon-btn"
                          title="复制"
                          onClick={() => void copyText(m.content)}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                            <rect x="9" y="9" width="11" height="11" rx="2" />
                            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                          </svg>
                        </button>
                        {m.turnId && onForkFromTurn && (
                          <button
                            type="button"
                            className="icon-btn"
                            title="从此处分叉"
                            onClick={() => void onForkFromTurn(m.turnId!)}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                              <circle cx="6" cy="6" r="2.2" />
                              <circle cx="6" cy="18" r="2.2" />
                              <circle cx="18" cy="12" r="2.2" />
                              <path d="M8 7.5v9M8 12h7.5" strokeLinecap="round" />
                            </svg>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ) : null}
              </>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {turnDiff ? (
        <details className="collapsible-card turn-diff-card" open>
          <summary>本轮变更</summary>
          <pre className="turn-diff-body">{turnDiff}</pre>
        </details>
      ) : null}

      <div className="composer-wrap">
        <div
          className={`composer-stack${queuedMessages.length > 0 ? ' has-queue' : ''}${
            modelMenuOpen || menuOpen || contextOpen || slashOpen || atOpen
              ? ' popover-open'
              : ''
          }`}
        >
          {queuedMessages.length > 0 && (
            <div className="queue-panel">
              <button
                type="button"
                className="queue-section-toggle"
                onClick={() => setQueueOpen((v) => !v)}
                aria-expanded={queueOpen}
              >
                <svg
                  className={`queue-chevron${queueOpen ? ' open' : ''}`}
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
                <span>
                  {queuedMessages.length === 1
                    ? '1 条排队消息'
                    : `${queuedMessages.length} 条排队消息`}
                </span>
              </button>

              {queueOpen && (
                <ul className="queue-list">
                  {queuedMessages.map((m) => (
                    <li
                      key={m.id}
                      className={`queue-item${m.sendingSoon ? ' sending-soon' : ''}`}
                    >
                      <span className="queue-dot" aria-hidden />
                      <span className="queue-item-text">{m.content}</span>
                      <div className="queue-item-actions">
                        <button
                          type="button"
                          className="queue-item-btn send-now"
                          title="中断当前任务并立即发送这条"
                          disabled={!!m.sendingSoon}
                          onClick={() => void onSendPendingNow?.(m.id)}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M12 19V5M5 12l7-7 7 7" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="queue-item-btn remove"
                          title="从队列删除"
                          disabled={!!m.sendingSoon}
                          onClick={() => void onCancelPending?.(m.id)}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M6 6l12 12M18 6L6 18" />
                          </svg>
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="queue-panel-bottom">
                {running ? (
                  <button
                    type="button"
                    className="queue-stop"
                    onClick={() => void onInterrupt()}
                    title="中断当前任务"
                  >
                    停止
                    <kbd>⌘⇧⌫</kbd>
                  </button>
                ) : (
                  <span className="queue-bottom-hint">当前任务结束后按序发送</span>
                )}
                {!!onInterruptAndClear && (running || queueCount > 0) && (
                  <button
                    type="button"
                    className="btn btn-danger"
                    style={{ marginLeft: 8 }}
                    onClick={() => void onInterruptAndClear()}
                    title="中断当前轮并清空 chat / cron 排队"
                  >
                    停止并清空排队
                  </button>
                )}
              </div>
            </div>
          )}

          <div
            className={`composer${dragOver ? ' drag-over' : ''}`}
            ref={composerRef}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const files = Array.from(e.dataTransfer.files ?? []);
              const paths = files
                .map((f) => (f as File & { path?: string }).path)
                .filter((p): p is string => typeof p === 'string' && !!p);
              if (paths.length) addImagePaths(paths);
              else if (files.length) setAttachError('只能添加图片文件');
            }}
          >
          {(error || statusText || attachError) && (
            <div className={`composer-status ${error || attachError ? 'error' : ''}`}>
              {error || attachError || statusText}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="composer-attachments">
              {attachments.map((path) => (
                <div key={path} className="composer-attach-item" title={path}>
                  <img src={convertFileSrc(path)} alt={fileName(path)} />
                  <button
                    type="button"
                    className="composer-attach-remove"
                    title="移除"
                    onClick={() =>
                      setAttachments((prev) => prev.filter((p) => p !== path))
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {goal?.objective && (
            <div className="composer-attachments">
              <div
                className="composer-chip composer-goal-chip"
                title={[
                  goal.objective,
                  goal.status ? `状态 ${goal.status}` : '',
                  goal.tokenBudget != null
                    ? `${goal.tokensUsed}/${goal.tokenBudget} tokens`
                    : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              >
                <span className="composer-goal-label">目标</span>
                <span className="composer-goal-text">{goal.objective}</span>
                <button
                  type="button"
                  className="composer-attach-remove"
                  title="清除目标（或输入 /goal clear）"
                  onClick={() => void onClearGoal?.()}
                >
                  ×
                </button>
              </div>
            </div>
          )}
          {!!atItems.length && (
            <div className="composer-attachments">
              {atItems.map((item) => (
                <div key={`${item.kind}:${item.path}`} className="composer-chip" title={item.path}>
                  @{item.label}
                  <button
                    type="button"
                    className="composer-attach-remove"
                    onClick={() =>
                      setAtItems((prev) =>
                        prev.filter((p) => !(p.kind === item.kind && p.path === item.path)),
                      )
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div style={{ position: 'relative' }}>
            {slashOpen && !!slashSuggestions.length && (
              <div className="permissions-popover slash-popover" role="menu">
                <div className="permissions-popover-title">命令</div>
                {slashSuggestions.map((s, i) => (
                  <button
                    key={s.id}
                    type="button"
                    role="menuitem"
                    className={`permissions-option ${i === slashIndex ? 'selected' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pickSlashCommand(s);
                    }}
                  >
                    <span className="permissions-option-label">{s.label}</span>
                    <span className="permissions-option-desc">{s.description}</span>
                  </button>
                ))}
              </div>
            )}
            {atOpen && !!atSuggestions.length && (
              <div className="permissions-popover" style={{ bottom: 'auto', top: '100%', zIndex: 50 }}>
                <div className="permissions-popover-title">插入 @</div>
                {atSuggestions.map((s, i) => (
                  <button
                    key={`${s.kind}:${s.path}`}
                    type="button"
                    className={`permissions-option ${i === atIndex ? 'selected' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pickAtItem(s);
                    }}
                  >
                    <span className="permissions-option-label">{s.label}</span>
                    <span className="permissions-option-desc">{s.path}</span>
                  </button>
                ))}
              </div>
            )}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            placeholder={
              running
                ? '发送后将并入当前轮…'
                : dragOver
                  ? '松开以添加图片'
                  : '输入消息，/ 命令，@ 引用 Skill 或文件'
            }
            rows={1}
            onKeyDown={(e) => {
              if (slashOpen && slashSuggestions.length) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSlashIndex((i) => (i + 1) % slashSuggestions.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSlashIndex(
                    (i) => (i - 1 + slashSuggestions.length) % slashSuggestions.length,
                  );
                  return;
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  pickSlashCommand(slashSuggestions[slashIndex] ?? slashSuggestions[0]);
                  return;
                }
                if (e.key === 'Tab' && !e.shiftKey) {
                  e.preventDefault();
                  pickSlashCommand(slashSuggestions[slashIndex] ?? slashSuggestions[0]);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setSlashOpen(false);
                  return;
                }
              }
              if (atOpen && atSuggestions.length) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setAtIndex((i) => (i + 1) % atSuggestions.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setAtIndex((i) => (i - 1 + atSuggestions.length) % atSuggestions.length);
                  return;
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  pickAtItem(atSuggestions[atIndex] ?? atSuggestions[0]);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setAtOpen(false);
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          </div>
          <div className="composer-toolbar">
            <div className="composer-left">
              {allowImages && (
                <button
                  type="button"
                  className="icon-btn"
                  title="添加图片"
                  onClick={() => void pickImages()}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
              )}
              <div className="permissions-menu" ref={menuRef}>
                <button
                  type="button"
                  className={`composer-chip ${menuOpen ? 'active' : ''}`}
                  title="权限（沙箱 / 审批）"
                  disabled={permissionsBusy}
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                  onClick={() => {
                    setContextOpen(false);
                    setModelMenuOpen(false);
                    setMenuOpen((v) => !v);
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                  </svg>
                  {chipLabel}
                </button>
                {menuOpen && (
                  <div className="permissions-popover" role="menu">
                    <div className="permissions-popover-title">权限</div>
                    {PERMISSIONS_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        role="menuitem"
                        className={`permissions-option ${presetId === preset.id ? 'selected' : ''}`}
                        onClick={() => void pickPreset(preset.permissions)}
                      >
                        <span className="permissions-option-label">{preset.label}</span>
                        <span className="permissions-option-desc">{preset.description}</span>
                      </button>
                    ))}
                    {presetId === 'custom' && permissions && (
                      <div className="permissions-custom-hint">
                        当前：{permissions.sandbox} · {permissions.approvalPolicy}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="composer-right">
              <div className="composer-menu-wrap" ref={modelMenuRef}>
                <button
                  type="button"
                  className={`composer-chip ${modelMenuOpen ? 'active' : ''}`}
                  title={currentModel}
                  onClick={() => {
                    setMenuOpen(false);
                    setContextOpen(false);
                    setModelMenuOpen((o) => !o);
                  }}
                >
                  {currentModelLabel}
                </button>
                {modelMenuOpen && (
                  <div className="permissions-popover model-popover" role="menu">
                    <div className="permissions-popover-title">模型</div>
                    {models.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        role="menuitem"
                        className={`permissions-option ${m.model === currentModel ? 'selected' : ''}`}
                        onClick={() => {
                          onSelectModel?.(m.model);
                          setModelMenuOpen(false);
                        }}
                      >
                        <span className="permissions-option-label">{m.label || m.model}</span>
                        <span className="permissions-option-desc">{m.model}</span>
                      </button>
                    ))}
                    {showEffort && (
                      <div className="permissions-submenu-wrap">
                        <button
                          type="button"
                          role="menuitem"
                          className={`permissions-option permissions-submenu-trigger${
                            effortSubmenuOpen ? ' active' : ''
                          }`}
                          aria-expanded={effortSubmenuOpen}
                          aria-haspopup="menu"
                          onClick={() => setEffortSubmenuOpen((v) => !v)}
                        >
                          <span className="permissions-option-label">推理强度</span>
                          <span className="permissions-submenu-value">
                            {currentEffortLabel}
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </span>
                        </button>
                        {effortSubmenuOpen && (
                          <div className="permissions-submenu" role="menu">
                            <div className="permissions-popover-title">推理强度</div>
                            {effortOptions.map((e) => (
                              <button
                                key={e.effort}
                                type="button"
                                role="menuitem"
                                className={`permissions-option ${
                                  e.effort === currentEffort ? 'selected' : ''
                                }`}
                                onClick={() => {
                                  onSelectEffort?.(e.effort);
                                  setEffortSubmenuOpen(false);
                                }}
                              >
                                <span className="permissions-option-label">{e.effort}</span>
                                {!!e.description && (
                                  <span className="permissions-option-desc">{e.description}</span>
                                )}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {!!onChangeProvider && (
                      <button
                        type="button"
                        role="menuitem"
                        className="permissions-option"
                        onClick={() => {
                          setModelMenuOpen(false);
                          onChangeProvider();
                        }}
                      >
                        <span className="permissions-option-label">更改网关…</span>
                        <span className="permissions-option-desc">打开设置切换 Provider</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
              {sessionId && onCompact && (
                <div
                  className={`composer-menu-wrap${contextOpen ? ' is-open' : ''}`}
                  ref={contextMenuRef}
                >
                  <button
                    type="button"
                    className={`icon-btn${contextOpen ? ' active' : ''}`}
                    title={contextTitle}
                    aria-label={contextTitle}
                    aria-expanded={contextOpen}
                    aria-haspopup="dialog"
                    onClick={() => {
                      setMenuOpen(false);
                      setModelMenuOpen(false);
                      setContextOpen((v) => !v);
                    }}
                  >
                    <svg className="context-ring" width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                      <circle
                        className="context-ring-track"
                        cx="8"
                        cy="8"
                        r={contextRingR}
                        fill="none"
                        strokeWidth="1.8"
                      />
                      <circle
                        className="context-ring-value"
                        cx="8"
                        cy="8"
                        r={contextRingR}
                        fill="none"
                        stroke={contextRingColor}
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeDasharray={contextRingC}
                        strokeDashoffset={contextRingC * (1 - contextPct)}
                        transform="rotate(-90 8 8)"
                      />
                    </svg>
                  </button>
                  <ContextUsagePopover
                    open={contextOpen}
                    usage={tokenUsage}
                    busy={actionBusy}
                    onClose={() => setContextOpen(false)}
                    onCompact={() => {
                      setActionBusy(true);
                      void onCompact().finally(() => setActionBusy(false));
                    }}
                  />
                </div>
              )}
              {running && (
                <button
                  type="button"
                  className="send-btn stop"
                  title="中断当前任务"
                  onClick={() => void onInterrupt()}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </button>
              )}
              <button
                type="button"
                className="send-btn"
                disabled={!draft.trim() && !attachments.length}
                title={running ? '并入当前轮' : '发送'}
                onClick={() => void submit()}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            </div>
          </div>
          </div>
        </div>
      </div>
    </main>
  );
}

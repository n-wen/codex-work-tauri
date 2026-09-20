import { useCallback, useEffect, useRef, useState } from 'react';
import { ask } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { codexApi } from '../api';
import type {
  AgentPermissions,
  ApprovalRequest,
  AppSettings,
  ChatMessage,
  CodexEvent,
  DynamicToolConfirmRequest,
  McpElicitationRequest,
  Project,
  ProviderCapabilities,
  Session,
  ThreadActiveFlag,
  ThreadGoal,
  ThreadStatus,
  ThreadTokenUsage,
  ToolCallRecord,
  ToolUserInputRequest,
  QueueSnapshot,
} from '../types';
import { defaultModelId, loadCachedThreadTokenUsage, parseThreadTokenUsage, saveCachedThreadTokenUsage } from '../types';

/** null = ungrouped draft; string = draft under project; undefined = not drafting */
export type PendingProjectId = string | null | undefined;

function eventThreadId(params: Record<string, unknown>): string | null {
  const value = params.sessionId ?? params.threadId;
  return typeof value === 'string' && value.trim() ? value : null;
}

function unixToIso(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === 'string' && value.trim()) return value;
  return new Date().toISOString();
}

function normalizePath(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function parseThreadStatus(raw: unknown): ThreadStatus | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const type = (raw as { type?: unknown }).type;
  if (type === 'notLoaded' || type === 'idle' || type === 'systemError') {
    return { type };
  }
  if (type === 'active') {
    const flags = (raw as { activeFlags?: unknown }).activeFlags;
    const activeFlags = Array.isArray(flags)
      ? flags.filter(
          (f): f is ThreadActiveFlag =>
            f === 'waitingOnApproval' || f === 'waitingOnUserInput',
        )
      : [];
    return { type: 'active', activeFlags };
  }
  return undefined;
}

function sessionFromThreadNotification(
  thread: Record<string, unknown>,
  projects: Project[],
): Session | null {
  const id = typeof thread.id === 'string' ? thread.id.trim() : '';
  if (!id) return null;
  const cwd = typeof thread.cwd === 'string' ? thread.cwd.trim() : '';
  const cwdNorm = normalizePath(cwd);
  const project = projects.find((p) => {
    if (p.listed === false) return false;
    return normalizePath(p.workDir) === cwdNorm;
  });
  const name =
    typeof thread.name === 'string' ? thread.name.trim() : '';
  const preview =
    typeof thread.preview === 'string' ? thread.preview.trim() : '';
  const title = (name || preview || '新对话').slice(0, 80);
  return {
    id,
    projectId: project?.id ?? '',
    title,
    threadId: id,
    cwd: cwd || undefined,
    messages: [],
    createdAt: unixToIso(thread.createdAt),
    updatedAt: unixToIso(thread.updatedAt),
    status: parseThreadStatus(thread.status),
  };
}

function upsertSession(list: Session[], session: Session): Session[] {
  const idx = list.findIndex((s) => s.id === session.id);
  let next: Session[];
  if (idx < 0) {
    next = [session, ...list];
  } else {
    const prev = list[idx];
    next = list.map((s, i) =>
      i === idx
        ? {
            ...prev,
            title:
              session.title && session.title !== '新对话'
                ? session.title
                : prev.title,
            projectId: session.projectId || prev.projectId,
            cwd: session.cwd || prev.cwd,
            updatedAt: session.updatedAt || prev.updatedAt,
            status: session.status ?? prev.status,
          }
        : s,
    );
  }
  return [...next].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function useWorkbench() {
  const api = codexApi;

  const [booting, setBooting] = useState(true);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [permissions, setPermissions] = useState<AgentPermissions | null>(null);
  const [permissionsBusy, setPermissionsBusy] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [pendingProjectId, setPendingProjectId] = useState<PendingProjectId>(undefined);
  const [composerFocusKey, setComposerFocusKey] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const queueSnapshotRef = useRef<QueueSnapshot>({ chat: [], cron: [] });
  const [statusText, setStatusText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [turnDiff, setTurnDiff] = useState<string | null>(null);
  const [dynamicToolConfirm, setDynamicToolConfirm] =
    useState<DynamicToolConfirmRequest | null>(null);
  const [toolUserInput, setToolUserInput] = useState<ToolUserInputRequest | null>(null);
  const [mcpElicitation, setMcpElicitation] = useState<McpElicitationRequest | null>(null);
  const [threadGoal, setThreadGoal] = useState<ThreadGoal | null>(null);
  const [tokenUsageByThread, setTokenUsageByThread] = useState<
    Record<string, ThreadTokenUsage>
  >(loadCachedThreadTokenUsage);
  const [showSettings, setShowSettings] = useState(false);
  const [showPlugins, setShowPlugins] = useState(false);
  const [showScheduled, setShowScheduled] = useState(false);
  /** Model chosen before a session exists (composer draft). */
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftEffort, setDraftEffort] = useState<string | null>(null);
  const [providerCaps, setProviderCaps] = useState<ProviderCapabilities | null>(null);

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const listedProjects = projects.filter((p) => p.listed !== false);
  const effectiveSessionModel = activeSession?.model?.trim() || draftModel?.trim() || null;

  useEffect(() => {
    saveCachedThreadTokenUsage(tokenUsageByThread);
  }, [tokenUsageByThread]);

  const refreshProjects = useCallback(async () => {
    const list = await api.listProjects();
    setProjects(list);
    return list;
  }, [api]);

  const refreshAllSessions = useCallback(async () => {
    const list = await api.listAllSessions();
    setSessions((prev) => {
      const prevById = new Map(prev.map((s) => [s.id, s]));
      return list.map((s) => {
        const old = prevById.get(s.id);
        if (
          old?.status &&
          (!s.status || s.status.type === 'notLoaded') &&
          old.status.type !== 'notLoaded'
        ) {
          return { ...s, status: old.status };
        }
        return s;
      });
    });
    return list;
  }, [api]);

  /** Server-side `thread/list.searchTerm`; upsert hits into the sidebar list. */
  const searchSessions = useCallback(
    async (searchTerm: string) => {
      const term = searchTerm.trim();
      if (!term) {
        return refreshAllSessions();
      }
      const hits = await api.searchSessions(term);
      setSessions((prev) => {
        let next = prev;
        for (const hit of hits) {
          next = upsertSession(next, hit);
        }
        return next;
      });
      return hits;
    },
    [api, refreshAllSessions],
  );
  const mergeQueueIntoMessages = useCallback((sessionId: string | null, base: ChatMessage[]) => {
    const snap = queueSnapshotRef.current.chat.filter((c) => c.sessionId === sessionId);
    if (!sessionId) {
      return base.map((m) => (m.queued ? { ...m, queued: false, sendingSoon: false } : m));
    }

    const snapById = new Map(snap.map((c) => [c.id, c]));
    const usedSnapIds = new Set<string>();
    const next: ChatMessage[] = [];

    for (const m of base) {
      if (!m.queued) {
        next.push(m);
        continue;
      }

      const byId = snapById.get(m.id);
      if (byId) {
        usedSnapIds.add(byId.id);
        next.push({
          ...m,
          content: byId.text,
          queued: true,
          sendingSoon: !!byId.sendingSoon,
        });
        continue;
      }

      // Optimistic local id: bind to unused snapshot item with same text.
      const byText = snap.find((c) => !usedSnapIds.has(c.id) && c.text === m.content);
      if (byText) {
        usedSnapIds.add(byText.id);
        next.push({
          ...m,
          id: byText.id,
          content: byText.text,
          queued: true,
          sendingSoon: !!byText.sendingSoon,
        });
        continue;
      }

      // Left the queue (drained / cancelled). Keep as normal user bubble.
      next.push({ ...m, queued: false, sendingSoon: false });
    }

    for (const item of snap) {
      if (usedSnapIds.has(item.id)) continue;
      if (next.some((m) => m.id === item.id)) continue;
      next.push({
        id: item.id,
        role: 'user',
        content: item.text,
        createdAt: item.createdAt,
        queued: true,
        sendingSoon: !!item.sendingSoon,
      });
    }

    // Final dedupe by id (keep last).
    const deduped = new Map<string, ChatMessage>();
    for (const m of next) deduped.set(m.id, m);
    return Array.from(deduped.values());
  }, []);

  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const streamingIdRef = useRef(streamingId);
  streamingIdRef.current = streamingId;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  /** After 「立即执行」, switch UI to that job's thread when known. */
  const pendingScheduledFocusJobIdRef = useRef<string | null>(null);
  /** Live items not yet visible in thread/read (e.g. scheduled userMessage). */
  const liveExtrasRef = useRef<ChatMessage[]>([]);
  /** Current turn id for the active session (from turn/start). */
  const activeTurnIdRef = useRef<string | null>(null);

  const loadSessionMessages = useCallback(
    async (projectId: string, sessionId: string) => {
      const session = await api.getSession(projectId, sessionId);
      if (activeSessionIdRef.current !== sessionId) return;
      const base = mergeQueueIntoMessages(sessionId, session?.messages ?? []);
      const baseIds = new Set(base.map((m) => m.id));
      const extras = liveExtrasRef.current.filter((m) => !baseIds.has(m.id));
      liveExtrasRef.current = extras;
      setMessages(extras.length ? [...base, ...extras] : base);
    },
    [api, mergeQueueIntoMessages],
  );

  const loadPermissions = useCallback(async () => {
    try {
      const next = await api.getAgentPermissions();
      setPermissions(next);
      return next;
    } catch (err) {
      console.warn('[permissions] load failed', err);
      const fallback: AgentPermissions = {
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
      };
      setPermissions(fallback);
      return fallback;
    }
  }, [api]);

  const loadProviderCapabilities = useCallback(
    async (model?: string | null) => {
      try {
        const caps = await api.getProviderCapabilities(model);
        setProviderCaps(caps);
        setDraftEffort((prev) => prev || caps.defaultReasoningEffort || null);
        return caps;
      } catch (err) {
        console.warn('[capabilities] load failed', err);
        setProviderCaps({
          namespaceTools: true,
          imageGeneration: false,
          webSearch: false,
          inputImages: true,
          reasoningEfforts: [],
          defaultReasoningEffort: null,
        });
        return null;
      }
    },
    [api],
  );

  useEffect(() => {
    (async () => {
      try {
        const s = await api.getSettings();
        setSettings(s);
        const list = await api.listProjects();
        setProjects(list);
        if (s) {
          await loadPermissions();
          await loadProviderCapabilities(defaultModelId(s));
          const allSessions = await api.listAllSessions();
          setSessions(allSessions);
          const visible = list.filter((p) => p.listed !== false);
          if (visible[0]) {
            setActiveProjectId(visible[0].id);
          }
          if (allSessions[0]) {
            setActiveSessionId(allSessions[0].id);
            setActiveProjectId(allSessions[0].projectId || null);
            setMessages(allSessions[0].messages);
            if (allSessions[0].id) {
              await loadSessionMessages(allSessions[0].projectId, allSessions[0].id);
            }
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBooting(false);
      }
    })();
  }, [api, loadPermissions, loadProviderCapabilities, loadSessionMessages]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        const snap = queueSnapshotRef.current;
        const chatN = snap.chat?.length ?? 0;
        const cronN = snap.cron?.length ?? 0;
        if (chatN + cronN <= 0) return;
        const parts: string[] = [];
        if (chatN > 0) {
          parts.push(`${chatN} 条聊天排队会在下次启动恢复`);
        }
        if (cronN > 0) {
          parts.push(
            `${cronN} 条到期任务调度会丢（jobs 定义仍在「已安排」）`,
          );
        }
        const ok = await ask(`${parts.join('；')}。确定退出？`, {
          title: '退出确认',
          kind: 'warning',
        });
        if (!ok) event.preventDefault();
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      unlisten?.();
    };
  }, []);

  const openSessionById = useCallback(
    async (sessionId: string) => {
      if (!sessionId.trim()) return;
      // Claim focus synchronously so live item/userMessage / deltas are not
      // dropped while we await thread/read.
      const switching = activeSessionIdRef.current !== sessionId;
      activeSessionIdRef.current = sessionId;
      setActiveSessionId(sessionId);
      if (switching) {
        liveExtrasRef.current = [];
        activeTurnIdRef.current = null;
      }
      setShowScheduled(false);
      setShowSettings(false);
      setShowPlugins(false);
      setPendingProjectId(undefined);

      let session = sessions.find((s) => s.id === sessionId);
      if (!session) {
        const list = await refreshAllSessions();
        // Bail if user switched away during refresh.
        if (activeSessionIdRef.current !== sessionId) return;
        session = list.find((s) => s.id === sessionId);
      }
      if (session) {
        setActiveProjectId(session.projectId || null);
        await loadSessionMessages(session.projectId, sessionId);
        try {
          const res = await api.threadGoalGet(sessionId);
          if (activeSessionIdRef.current === sessionId) {
            setThreadGoal(res.goal ?? null);
          }
        } catch {
          if (activeSessionIdRef.current === sessionId) setThreadGoal(null);
        }
        return;
      }
      await loadSessionMessages('', sessionId);
      setThreadGoal(null);
      void refreshAllSessions();
    },
    [sessions, refreshAllSessions, loadSessionMessages, api],
  );

  const focusScheduledRun = useCallback(
    (jobId: string, knownThreadId?: string | null) => {
      pendingScheduledFocusJobIdRef.current = jobId;
      setShowScheduled(false);
      setShowSettings(false);
      setShowPlugins(false);
      if (knownThreadId) {
        void openSessionById(knownThreadId);
      }
    },
    [openSessionById],
  );

  useEffect(() => {
    const tryFocusScheduled = (jobId: string | undefined, threadId: string | null) => {
      if (!jobId || !threadId) return;
      if (pendingScheduledFocusJobIdRef.current !== jobId) return;
      pendingScheduledFocusJobIdRef.current = null;
      void openSessionById(threadId);
    };

    const offEvent = api.onEvent((event: CodexEvent) => {
      const { method, params } = event;
      const threadId = eventThreadId(params);
      const viewingThisThread =
        !!threadId && threadId === activeSessionIdRef.current;

      if (method === 'session/start') {
        const jobId =
          typeof params.jobId === 'string' ? params.jobId : undefined;
        if (params.origin === 'scheduled') {
          tryFocusScheduled(jobId, threadId);
        }
      }

      if (method === 'thread/started') {
        const thread =
          params.thread && typeof params.thread === 'object'
            ? (params.thread as Record<string, unknown>)
            : null;
        if (thread) {
          const session = sessionFromThreadNotification(thread, projectsRef.current);
          if (session) {
            setSessions((list) => upsertSession(list, session));
          }
        } else {
          void refreshAllSessions();
        }
      }

      if (method === 'thread/status/changed') {
        const id = eventThreadId(params);
        const status = parseThreadStatus(params.status);
        if (id && status) {
          setSessions((list) =>
            list.map((s) => (s.id === id ? { ...s, status } : s)),
          );
        }
      }

      if (
        method === 'thread/archived' ||
        method === 'thread/deleted'
      ) {
        const id =
          (typeof params.threadId === 'string' && params.threadId) ||
          eventThreadId(params);
        if (!id) return;
        setSessions((list) => list.filter((s) => s.id !== id));
        setTokenUsageByThread((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
        if (activeSessionIdRef.current === id) {
          activeSessionIdRef.current = null;
          liveExtrasRef.current = [];
          activeTurnIdRef.current = null;
          setActiveSessionId(null);
          setMessages([]);
          setStreamingId(null);
          setRunning(false);
          setStatusText('');
          setError(null);
        }
      }

      if (method === 'thread/unarchived') {
        // External unarchive: refresh list so the thread reappears.
        void refreshAllSessions();
      }

      if (method === 'thread/name/updated') {
        const id =
          (typeof params.threadId === 'string' && params.threadId) ||
          (typeof params.id === 'string' && params.id) ||
          '';
        const name =
          (typeof params.threadName === 'string' && params.threadName.trim()) ||
          (typeof params.name === 'string' && params.name.trim()) ||
          (typeof params.title === 'string' && params.title.trim()) ||
          '';
        if (id && name) {
          setSessions((prev) =>
            prev.map((s) => (s.id === id ? { ...s, title: name.slice(0, 80) } : s)),
          );
        }
      }

      if (
        method === 'warning' ||
        method === 'configWarning' ||
        method === 'deprecationNotice' ||
        method === 'guardianWarning'
      ) {
        const msg =
          (typeof params.message === 'string' && params.message) ||
          (typeof params.warning === 'string' && params.warning) ||
          (typeof params.text === 'string' && params.text) ||
          JSON.stringify(params);
        setError(msg);
      }

      if (method === 'serverRequest/resolved') {
        const rid =
          (typeof params.requestId === 'string' && params.requestId) ||
          (typeof params.id === 'string' && params.id) ||
          '';
        if (rid) {
          setApproval((cur) => (cur?.requestId === rid ? null : cur));
          setDynamicToolConfirm((cur) => (cur?.requestId === rid ? null : cur));
          setToolUserInput((cur) => (cur?.requestId === rid ? null : cur));
          setMcpElicitation((cur) => (cur?.requestId === rid ? null : cur));
        }
      }

      if (method === 'item/userMessage') {
        if (!viewingThisThread) return;
        const messageId = String(params.messageId ?? '');
        const content = String(params.content ?? '');
        const clientId =
          typeof params.clientId === 'string' && params.clientId.trim()
            ? params.clientId.trim()
            : '';
        if (!messageId) return;
        // Text-less image-only still reconciles when App Server echoes clientId.
        if (!content && !clientId) return;

        setMessages((prev) => {
          if (prev.some((m) => m.id === messageId)) {
            // Already have this item id — just clear pending delivery if needed.
            liveExtrasRef.current = liveExtrasRef.current.filter((m) => m.id !== messageId);
            return prev.map((m) =>
              m.id === messageId && m.delivery === 'pending'
                ? { ...m, delivery: 'received' as const }
                : m,
            );
          }

          // Prefer clientId (= optimistic pendingId) so skill/mention/whitespace
          // mismatches cannot leave「发送中」stuck.
          let optimisticIdx = -1;
          if (clientId) {
            optimisticIdx = prev.findIndex(
              (m) => m.role === 'user' && m.id === clientId,
            );
          }
          if (optimisticIdx < 0) {
            for (let i = prev.length - 1; i >= 0; i -= 1) {
              const m = prev[i];
              if (
                m.role === 'user' &&
                (m.delivery === 'pending' ||
                  m.id.startsWith('local-') ||
                  m.id.startsWith('pending-')) &&
                (!content || m.content === content)
              ) {
                optimisticIdx = i;
                break;
              }
            }
          }
          if (optimisticIdx >= 0) {
            const next = [...prev];
            const oldId = next[optimisticIdx].id;
            next[optimisticIdx] = {
              ...next[optimisticIdx],
              id: messageId,
              content: content || next[optimisticIdx].content,
              delivery: 'received',
              queued: false,
              sendingSoon: false,
              turnId: next[optimisticIdx].turnId ?? activeTurnIdRef.current ?? undefined,
            };
            liveExtrasRef.current = liveExtrasRef.current.filter(
              (m) => m.id !== messageId && m.id !== oldId,
            );
            return next;
          }

          // Scheduled / external turns: no optimistic bubble — insert once.
          // Only reorder ahead of the *currently streaming* assistant (same turn
          // race). Never insert before a prior turn's completed reply.
          const userMsg: ChatMessage = {
            id: messageId,
            role: 'user',
            content,
            createdAt: new Date().toISOString(),
            turnId: activeTurnIdRef.current ?? undefined,
          };
          liveExtrasRef.current = [
            ...liveExtrasRef.current.filter((m) => m.id !== messageId),
            userMsg,
          ];
          const streamId = streamingIdRef.current;
          const streamIdx = streamId
            ? prev.findIndex((m) => m.id === streamId && m.role === 'assistant')
            : -1;
          if (streamIdx >= 0) {
            const next = [...prev];
            next.splice(streamIdx, 0, userMsg);
            return next;
          }
          return [...prev, userMsg];
        });
      }

      if (method === 'turn/start') {
        const turnId =
          typeof params.turnId === 'string' && params.turnId.trim()
            ? params.turnId
            : null;
        if (viewingThisThread) {
          activeTurnIdRef.current = turnId;
          setTurnDiff(null);
          // Fallback: App Server accepted the turn — clear stuck「发送中」even if
          // item/userMessage content didn't match the optimistic bubble.
          setMessages((prev) =>
            prev.map((m) =>
              m.role === 'user' && m.delivery === 'pending'
                ? {
                    ...m,
                    delivery: 'received' as const,
                    queued: false,
                    sendingSoon: false,
                    turnId: m.turnId ?? turnId ?? undefined,
                  }
                : m,
            ),
          );
          setRunning(true);
          setStatusText('任务进行中…');
          setError(null);
        }
      }

      if (method === 'item/agentMessage/delta') {
        if (!viewingThisThread) return;
        const messageId = String(params.messageId);
        const delta = String(params.delta ?? '');
        setStreamingId(messageId);
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = {
              ...next[idx],
              content: next[idx].content + delta,
              turnId: next[idx].turnId ?? activeTurnIdRef.current ?? undefined,
            };
            return next;
          }
          return [
            ...prev,
            {
              id: messageId,
              role: 'assistant',
              content: delta,
              createdAt: new Date().toISOString(),
              turnId: activeTurnIdRef.current ?? undefined,
            },
          ];
        });
      }

      if (method === 'item/agentMessage/completed') {
        if (!viewingThisThread) return;
        const messageId = String(params.messageId);
        const content = String(params.content ?? '');
        const toolCalls = params.toolCalls as ToolCallRecord[] | undefined;
        setStreamingId(null);
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = {
              ...next[idx],
              content,
              toolCalls,
              turnId: next[idx].turnId ?? activeTurnIdRef.current ?? undefined,
            };
            return next;
          }
          return [
            ...prev,
            {
              id: messageId,
              role: 'assistant',
              content,
              toolCalls,
              createdAt: new Date().toISOString(),
              turnId: activeTurnIdRef.current ?? undefined,
            },
          ];
        });
      }

      if (method === 'item/toolCall' || method === 'item/toolCall/updated') {
        if (!viewingThisThread) return;
        const messageId = String(params.messageId);
        const toolCall = params.toolCall as ToolCallRecord;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== messageId) return m;
            const existing = m.toolCalls ?? [];
            const i = existing.findIndex((t) => t.id === toolCall.id);
            const toolCalls =
              i >= 0
                ? existing.map((t, idx) => {
                    if (idx !== i) return t;
                    // Preserve streamed output if the completed payload has none yet.
                    if (
                      (!toolCall.result || !toolCall.result.length) &&
                      t.result &&
                      t.status === 'running'
                    ) {
                      return { ...toolCall, result: t.result };
                    }
                    return toolCall;
                  })
                : [...existing, toolCall];
            return { ...m, toolCalls };
          }),
        );
      }

      if (method === 'item/commandExecution/outputDelta') {
        if (!viewingThisThread) return;
        const itemId = String(params.itemId ?? '');
        const delta = String(params.delta ?? '');
        if (!itemId || !delta) return;
        setMessages((prev) =>
          prev.map((m) => {
            const tools = m.toolCalls;
            if (!tools?.length) return m;
            const i = tools.findIndex((t) => t.id === itemId);
            if (i < 0) return m;
            const nextTools = tools.map((t, idx) =>
              idx === i
                ? {
                    ...t,
                    status:
                      t.status === 'pending_approval'
                        ? ('pending_approval' as const)
                        : ('running' as const),
                    result: (t.result ?? '') + delta,
                  }
                : t,
            );
            return { ...m, toolCalls: nextTools };
          }),
        );
      }

      if (method === 'item/fileChange/patchUpdated') {
        if (!viewingThisThread) return;
        const itemId = String(params.itemId ?? '');
        const diffSummary = String(params.diffSummary ?? '');
        if (!itemId) return;
        setMessages((prev) =>
          prev.map((m) => {
            const tools = m.toolCalls;
            if (!tools?.length) return m;
            const i = tools.findIndex((t) => t.id === itemId);
            if (i < 0) return m;
            const nextTools = tools.map((t, idx) =>
              idx === i
                ? {
                    ...t,
                    diffSummary: diffSummary || t.diffSummary,
                    arguments: {
                      ...t.arguments,
                      changes: params.changes ?? t.arguments.changes,
                    },
                  }
                : t,
            );
            return { ...m, toolCalls: nextTools };
          }),
        );
      }

      if (method === 'turn/diff/updated') {
        if (!viewingThisThread) return;
        const diff = String(params.diff ?? '');
        setTurnDiff(diff || null);
      }

      if (method === 'item/reasoning') {
        if (!viewingThisThread) return;
        const messageId = String(params.messageId ?? '');
        const summary = String(params.summary ?? '');
        if (!messageId) return;
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = {
              ...next[idx],
              kind: 'reasoning',
              reasoningSummary: summary || next[idx].reasoningSummary,
              turnId:
                next[idx].turnId ??
                (typeof params.turnId === 'string' ? params.turnId : undefined),
            };
            return next;
          }
          return [
            ...prev,
            {
              id: messageId,
              role: 'assistant',
              content: '',
              kind: 'reasoning',
              reasoningSummary: summary,
              createdAt: new Date().toISOString(),
              turnId: typeof params.turnId === 'string' ? params.turnId : undefined,
            },
          ];
        });
      }

      if (method === 'item/reasoning/summaryTextDelta') {
        if (!viewingThisThread) return;
        const messageId = String(params.itemId ?? params.messageId ?? '');
        const delta = String(params.delta ?? '');
        if (!messageId || !delta) return;
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = {
              ...next[idx],
              kind: 'reasoning',
              reasoningSummary: (next[idx].reasoningSummary ?? '') + delta,
            };
            return next;
          }
          return [
            ...prev,
            {
              id: messageId,
              role: 'assistant',
              content: '',
              kind: 'reasoning',
              reasoningSummary: delta,
              createdAt: new Date().toISOString(),
              turnId: typeof params.turnId === 'string' ? params.turnId : undefined,
            },
          ];
        });
      }

      if (method === 'item/plan') {
        if (!viewingThisThread) return;
        const messageId = String(params.messageId ?? '');
        const text = String(params.text ?? '');
        if (!messageId) return;
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          const steps = text
            ? [{ step: text, status: 'inProgress' as const }]
            : undefined;
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = {
              ...next[idx],
              kind: 'plan',
              planSteps: steps ?? next[idx].planSteps,
            };
            return next;
          }
          return [
            ...prev,
            {
              id: messageId,
              role: 'assistant',
              content: '',
              kind: 'plan',
              planSteps: steps,
              createdAt: new Date().toISOString(),
              turnId: typeof params.turnId === 'string' ? params.turnId : undefined,
            },
          ];
        });
      }

      if (method === 'turn/plan/updated') {
        if (!viewingThisThread) return;
        const turnId = typeof params.turnId === 'string' ? params.turnId : '';
        const planId = turnId ? `plan-${turnId}` : 'plan-current';
        const rawPlan = Array.isArray(params.plan) ? params.plan : [];
        const planSteps = rawPlan
          .map((s) => {
            if (!s || typeof s !== 'object') return null;
            const step = String((s as { step?: unknown }).step ?? '');
            const status = String((s as { status?: unknown }).status ?? 'pending');
            if (!step) return null;
            return { step, status };
          })
          .filter((s): s is { step: string; status: string } => !!s);
        const explanation =
          typeof params.explanation === 'string' ? params.explanation : undefined;
        setMessages((prev) => {
          const idx = prev.findIndex(
            (m) => m.id === planId || (m.kind === 'plan' && m.turnId === turnId),
          );
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = {
              ...next[idx],
              id: planId,
              kind: 'plan',
              planSteps,
              planExplanation: explanation,
              turnId: turnId || next[idx].turnId,
            };
            return next;
          }
          return [
            ...prev,
            {
              id: planId,
              role: 'assistant',
              content: '',
              kind: 'plan',
              planSteps,
              planExplanation: explanation,
              createdAt: new Date().toISOString(),
              turnId: turnId || undefined,
            },
          ];
        });
      }

      if (method === 'turn/completed') {
        if (viewingThisThread) {
          setRunning(false);
          setStreamingId(null);
          setStatusText('任务完成');
          setMessages((prev) =>
            prev.map((m) =>
              m.delivery === 'pending' || m.delivery === 'received'
                ? { ...m, delivery: undefined }
                : m,
            ),
          );
        } else if (!threadId) {
          setRunning(false);
          setStreamingId(null);
        }
        void refreshAllSessions();
      }

      if (method === 'turn/interrupted') {
        if (viewingThisThread) {
          setRunning(false);
          setStreamingId(null);
          setApproval(null);
          setDynamicToolConfirm(null);
          setToolUserInput(null);
          setStatusText('已中断');
        } else if (!threadId) {
          setRunning(false);
          setStreamingId(null);
        }
      }

      if (method === 'thread/tokenUsage/updated') {
        const id =
          (typeof params.threadId === 'string' && params.threadId) || threadId;
        const usage = parseThreadTokenUsage(params);
        if (id && usage) {
          setTokenUsageByThread((prev) => {
            const { [id]: _ignored, ...rest } = prev;
            return { ...rest, [id]: usage };
          });
        }
      }

      if (method === 'thread/goal/updated' && viewingThisThread) {
        const g = params.goal;
        if (g && typeof g === 'object') {
          setThreadGoal(g as ThreadGoal);
        }
      }

      if (method === 'thread/goal/cleared' && viewingThisThread) {
        setThreadGoal(null);
      }

      if (method === 'turn/error') {
        if (viewingThisThread) {
          setRunning(false);
          setStreamingId(null);
          setStatusText('');
          setError(String(params.error ?? '未知错误'));
        } else if (!threadId) {
          setRunning(false);
          setStreamingId(null);
          setError(String(params.error ?? '未知错误'));
        }
      }
    });

    const offApproval = api.onApproval((req) => {
      // Hydrate write_file diff from the matching tool card when approval
      // params omit changes (schema often only has itemId).
      if (req.name === 'write_file' && !req.diffSummary) {
        const hit = messagesRef.current
          .flatMap((m) => m.toolCalls ?? [])
          .find((t) => t.id === req.toolCallId);
        if (hit?.diffSummary) {
          setApproval({ ...req, diffSummary: hit.diffSummary });
          return;
        }
      }
      setApproval(req);
    });
    const offDynamicTool = api.onDynamicTool((req) => setDynamicToolConfirm(req));
    const offMcpElicitation = api.onMcpElicitation((req) => setMcpElicitation(req));
    const offToolUserInput = api.onToolUserInput((req) => setToolUserInput(req));

    const offQueue = api.onQueue((snapshot: QueueSnapshot) => {
      queueSnapshotRef.current = snapshot;
      setQueueCount(snapshot.chat.length + (snapshot.cron?.length ?? 0));
      setMessages((prev) =>
        mergeQueueIntoMessages(activeSessionIdRef.current, prev),
      );
    });

    const offScheduled = api.onScheduled((payload) => {
      if (payload.status === 'error') {
        if (pendingScheduledFocusJobIdRef.current === payload.jobId) {
          pendingScheduledFocusJobIdRef.current = null;
          setError(payload.error ?? '定时任务执行失败');
        }
        return;
      }
      tryFocusScheduled(payload.jobId, payload.threadId ?? null);
    });

    return () => {
      offEvent();
      offApproval();
      offDynamicTool();
      offMcpElicitation();
      offToolUserInput();
      offQueue();
      offScheduled();
    };
  }, [api, refreshAllSessions, mergeQueueIntoMessages, openSessionById]);

  const selectProject = async (projectId: string) => {
    setActiveProjectId(projectId);
    setPendingProjectId(undefined);
    const projectSessions = sessions.filter((s) => s.projectId === projectId);
    if (projectSessions[0]) {
      setActiveSessionId(projectSessions[0].id);
      setMessages(projectSessions[0].messages);
    } else {
      // Empty project → draft under this project, ready to type
      setActiveSessionId(null);
      setMessages([]);
      setPendingProjectId(projectId);
      setComposerFocusKey((k) => k + 1);
    }
  };

  const selectSession = async (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;
    setPendingProjectId(undefined);
    setActiveProjectId(session.projectId || null);
    if (activeSessionIdRef.current !== sessionId) {
      liveExtrasRef.current = [];
      activeTurnIdRef.current = null;
      setRunning(session.status?.type === 'active');
      setStreamingId(null);
      setStatusText(session.status?.type === 'active' ? '任务进行中…' : '');
    }
    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
    await loadSessionMessages(session.projectId, sessionId);
    try {
      const res = await api.threadGoalGet(sessionId);
      setThreadGoal(res.goal ?? null);
    } catch {
      setThreadGoal(null);
    }
  };

  const createProject = async (name: string, workDir: string) => {
    const project = await api.createProject({ name, workDir });
    await refreshProjects();
    setActiveProjectId(project.id);
    setActiveSessionId(null);
    setMessages([]);
    setPendingProjectId(project.id);
    setComposerFocusKey((k) => k + 1);
    await refreshAllSessions();
  };

  const renameProject = async (id: string, name: string) => {
    await api.renameProject(id, name);
    await refreshProjects();
  };

  const deleteProject = async (id: string) => {
    await api.deleteProject(id);
    const list = await refreshProjects();
    await refreshAllSessions();
    if (activeProjectId !== id) return;
    setActiveSessionId(null);
    setMessages([]);
    setPendingProjectId(undefined);
    const visible = list.filter((p) => p.listed !== false);
    if (visible[0]) {
      await selectProject(visible[0].id);
    } else {
      setActiveProjectId(null);
    }
  };

  /** Focus composer only; session is created on first send. */
  const startNewChat = (projectId: string | null = null) => {
    setPendingProjectId(projectId);
    activeSessionIdRef.current = null;
    activeTurnIdRef.current = null;
    setActiveSessionId(null);
    setMessages([]);
    setThreadGoal(null);
    setDraftModel(null);
    setError(null);
    setStatusText('');
    setRunning(false);
    setStreamingId(null);
    if (projectId) {
      setActiveProjectId(projectId);
    }
    setComposerFocusKey((k) => k + 1);
  };

  const renameSession = async (sessionId: string, title: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;
    const prev = session.title;
    setSessions((list) =>
      list.map((s) => (s.id === sessionId ? { ...s, title, updatedAt: new Date().toISOString() } : s)),
    );
    try {
      await api.renameSession(session.projectId, sessionId, title);
      await refreshAllSessions();
    } catch (err) {
      setSessions((list) =>
        list.map((s) => (s.id === sessionId ? { ...s, title: prev } : s)),
      );
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const archiveSession = async (sessionId: string) => {
    try {
      await api.archiveSession(sessionId);
      setSessions((list) => list.filter((s) => s.id !== sessionId));
      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
        setMessages([]);
        setStatusText('');
        setError(null);
      }
      await refreshAllSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const archiveProjectSessions = async (projectId: string) => {
    const ids = sessions
      .filter((s) => s.projectId === projectId)
      .map((s) => s.id);
    if (!ids.length) return;

    const failed: string[] = [];
    for (const id of ids) {
      try {
        await api.archiveSession(id);
      } catch {
        failed.push(id);
      }
    }

    const archived = new Set(ids.filter((id) => !failed.includes(id)));
    setSessions((list) => list.filter((s) => !archived.has(s.id)));
    if (activeSessionId && archived.has(activeSessionId)) {
      activeSessionIdRef.current = null;
      liveExtrasRef.current = [];
      activeTurnIdRef.current = null;
      setActiveSessionId(null);
      setMessages([]);
      setStreamingId(null);
      setRunning(false);
      setStatusText('');
      setError(null);
      startNewChat(projectId);
    }
    if (failed.length) {
      setError(`有 ${failed.length} 条会话归档失败`);
    }
    await refreshAllSessions();
  };

  const forkSession = async (sessionId: string, lastTurnId?: string | null) => {
    try {
      const session = await api.forkSession(sessionId, lastTurnId);
      setSessions((list) => upsertSession(list, session));
      activeSessionIdRef.current = session.id;
      liveExtrasRef.current = [];
      activeTurnIdRef.current = null;
      setActiveSessionId(session.id);
      setActiveProjectId(session.projectId || null);
      setPendingProjectId(undefined);
      setShowSettings(false);
      setShowPlugins(false);
      setShowScheduled(false);
      setMessages(session.messages ?? []);
      setStreamingId(null);
      setRunning(false);
      setStatusText('');
      setError(null);
      setComposerFocusKey((k) => k + 1);
      await refreshAllSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const unarchiveSession = async (sessionId: string) => {
    await api.unarchiveSession(sessionId);
    await refreshAllSessions();
  };

  const deleteSession = async (sessionId: string) => {
    await api.deleteSession(sessionId);
    setSessions((list) => list.filter((s) => s.id !== sessionId));
    if (activeSessionId === sessionId) {
      setActiveSessionId(null);
      setMessages([]);
      setStatusText('');
      setError(null);
    }
    await refreshAllSessions();
  };



  const sendMessage = async (
    text: string,
    images: string[] = [],
    extras?: {
      skills?: { name: string; path: string }[];
      mentions?: { name: string; path: string }[];
    },
  ) => {
    const content = text.trim();
    const imagePaths = images.map((p) => p.trim()).filter(Boolean);
    if (!content && !imagePaths.length && !extras?.skills?.length && !extras?.mentions?.length) {
      return;
    }

    let projectId = activeProjectId;
    let sessionId = activeSessionId;

    try {
      if (!sessionId) {
        let pid: string | null = null;
        if (typeof pendingProjectId === 'string') {
          pid = pendingProjectId;
        } else if (pendingProjectId === null) {
          pid = null;
        } else if (projectId) {
          pid = projectId;
        }

        const title = content.slice(0, 40) || (imagePaths.length ? '图片' : '新对话');
        const session = await api.createSession(pid, title);
        sessionId = session.id;
        projectId = session.projectId || pid;
        const preferredModel = draftModel?.trim() || undefined;
        const sessionWithModel = preferredModel
          ? { ...session, model: preferredModel }
          : session;
        // List membership comes from thread/started (no thread/list refresh here).
        // If the event already arrived, patch title / projectId from create result.
        setSessions((list) =>
          list.some((s) => s.id === session.id)
            ? upsertSession(list, sessionWithModel)
            : list,
        );
        activeSessionIdRef.current = sessionId;
        setActiveSessionId(sessionId);
        if (projectId) setActiveProjectId(projectId);
        setPendingProjectId(undefined);
        setDraftModel(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    if (!sessionId) return;

    // Running → backend steers into the active turn (not chat queue).
    // Only mark queued if the RPC result says so (fallback / other-session busy).
    const pendingId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? `local-${crypto.randomUUID()}`
        : `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const userMsg: ChatMessage = {
      id: pendingId,
      role: 'user',
      content,
      images: imagePaths.length ? imagePaths : undefined,
      createdAt: new Date().toISOString(),
      delivery: 'pending',
      turnId: running ? activeTurnIdRef.current ?? undefined : undefined,
    };
    setMessages((prev) => [...prev, userMsg]);
    if (!running) setRunning(true);
    setError(null);

    const result = await api.startTurn({
      projectId: projectId ?? '',
      sessionId,
      message: content,
      pendingId,
      images: imagePaths,
      model:
        sessions.find((s) => s.id === sessionId)?.model?.trim() ||
        draftModel?.trim() ||
        undefined,
      effort: draftEffort?.trim() || undefined,
      skills: extras?.skills,
      mentions: extras?.mentions,
    });

    if (!result.ok) {
      if (!running) setRunning(false);
      setError(result.error);
      setMessages((prev) => prev.filter((m) => m.id !== pendingId));
      await loadSessionMessages(projectId ?? '', sessionId);
      return;
    }

    if (result.queued) {
      const realId = result.pendingId || pendingId;
      setMessages((prev) => {
        const mapped = prev.map((m) =>
          m.id === pendingId ? { ...m, id: realId, queued: true, delivery: undefined } : m,
        );
        const seen = new Set<string>();
        return mapped.filter((m) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });
      });
    }
    // Sidebar updates via thread/started / status/changed; full list refresh on turn/completed.
  };

  const cancelPending = async (id: string) => {
    setMessages((prev) => {
      const target = prev.find((m) => m.id === id);
      return prev.filter((m) => {
        if (m.id === id) return false;
        // Drop optimistic twins that never remapped.
        if (
          target &&
          m.queued &&
          m.content === target.content &&
          m.id.startsWith('local-')
        ) {
          return false;
        }
        return true;
      });
    });
    const result = await api.cancelPending(id);
    if (!result.ok) {
      setError(result.error);
    }
  };

  const sendPendingNow = async (id: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, sendingSoon: true } : m)),
    );
    const result = await api.sendPendingNow(id);
    if (!result.ok) {
      setError(result.error);
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, sendingSoon: false } : m)),
      );
    }
  };

  const interrupt = async () => {
    const sid = activeSessionIdRef.current ?? undefined;
    await api.interruptTurn(sid);
  };

  const interruptAndClearQueues = async () => {
    await api.interruptAndClearQueues();
    setRunning(false);
    setStreamingId(null);
    setStatusText('已中断并清空排队');
    setQueueCount(0);
  };

  const respondApproval = async (
    decision: import('../types').ApprovalDecision,
    applyNetworkAmendment?: import('../types').ApprovalNetworkAmendment | null,
  ) => {
    if (!approval) return;
    const id = approval.requestId;
    setApproval(null);
    if (decision === 'cancel') {
      setRunning(false);
      setStreamingId(null);
      setStatusText('已中断');
    }
    await api.respondApproval(id, decision, applyNetworkAmendment);
  };

  const respondDynamicTool = async (allowed: boolean) => {
    if (!dynamicToolConfirm) return;
    const id = dynamicToolConfirm.requestId;
    setDynamicToolConfirm(null);
    await api.respondDynamicTool(id, allowed);
  };

  const respondMcpElicitation = async (
    action: 'accept' | 'decline' | 'cancel',
    content?: unknown,
  ) => {
    if (!mcpElicitation) return;
    const id = mcpElicitation.requestId;
    setMcpElicitation(null);
    await api.respondMcpElicitation(id, action, content);
  };

  const respondToolUserInput = async (
    answers: Record<string, { answers: string[] }>,
  ) => {
    if (!toolUserInput) return;
    const id = toolUserInput.requestId;
    setToolUserInput(null);
    await api.respondToolUserInput(id, answers);
  };

  const cancelToolUserInput = async () => {
    if (!toolUserInput) return;
    const id = toolUserInput.requestId;
    setToolUserInput(null);
    await api.respondToolUserInput(id, {});
  };

  const setGoal = async (objective: string) => {
    const id = activeSessionId;
    if (!id) return;
    await api.threadGoalSet(id, objective, 'active', null);
    const res = await api.threadGoalGet(id);
    setThreadGoal(res.goal ?? null);
  };

  const clearGoal = async () => {
    const id = activeSessionId;
    if (!id) return;
    await api.threadGoalClear(id);
    setThreadGoal(null);
  };

  const compactThread = async () => {
    const id = activeSessionId;
    if (!id) return;
    setStatusText('正在压缩上下文…');
    try {
      await api.compactThread(id);
      setStatusText('上下文压缩已启动');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatusText('');
    }
  };

  const reviewStart = async (
    target: { type: string; [key: string]: unknown },
    delivery: 'inline' | 'detached' = 'inline',
    sessionId?: string,
  ) => {
    const id = sessionId?.trim() || activeSessionId;
    if (!id) return;
    if (id !== activeSessionIdRef.current) {
      await selectSession(id);
    }
    setStatusText('正在启动 Review…');
    try {
      const res = (await api.reviewStart(id, target, delivery)) as {
        reviewThreadId?: string | null;
      };
      if (delivery === 'detached' && res?.reviewThreadId) {
        const newId = String(res.reviewThreadId);
        await refreshAllSessions();
        await selectSession(newId);
      }
      setStatusText('Review 已启动');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatusText('');
    }
  };

  const reviewUncommitted = async (sessionId?: string) => {
    await reviewStart({ type: 'uncommittedChanges' }, 'inline', sessionId);
  };

  const saveSettings = async (next: AppSettings) => {
    const result = await api.saveSettings(next);
    if (result.ok) {
      setSettings(next);
      setShowSettings(false);
      try {
        await loadPermissions();
        await loadProviderCapabilities(defaultModelId(next));
      } catch {
        /* ignore */
      }
    }
    return result;
  };

  const setAgentPermissions = async (next: AgentPermissions) => {
    setPermissionsBusy(true);
    setError(null);
    try {
      const saved = await api.setAgentPermissions(next);
      setPermissions(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setPermissionsBusy(false);
    }
  };

  const setSessionModel = (model: string) => {
    const next = model.trim();
    if (!next) return;
    const id = activeSessionId;
    if (!id) {
      setDraftModel(next);
    } else {
      setSessions((list) =>
        list.map((s) => (s.id === id ? { ...s, model: next } : s)),
      );
    }
    void loadProviderCapabilities(next);
  };

  const setSessionEffort = (effort: string) => {
    const next = effort.trim();
    if (!next) return;
    setDraftEffort(next);
  };

  const refresh = async () => {
    await refreshProjects();
    await refreshAllSessions();
    if (activeSessionId && activeProjectId) {
      await loadSessionMessages(activeProjectId, activeSessionId);
    }
  };

  return {
    api,
    booting,
    settings,
    permissions,
    permissionsBusy,
    providerCaps,
    projects: listedProjects,
    sessions,
    activeProject,
    activeSession,
    effectiveSessionModel,
    activeProjectId,
    activeSessionId,
    pendingProjectId,
    composerFocusKey,
    messages,
    streamingId,
    running,
    statusText,
    error,
    setError,
    approval,
    turnDiff,
    dynamicToolConfirm,
    toolUserInput,
    mcpElicitation,
    threadGoal,
    tokenUsage: activeSessionId ? tokenUsageByThread[activeSessionId] ?? null : null,
    tokenUsageByThread,
    showSettings,
    setShowSettings,
    showPlugins,
    setShowPlugins,
    showScheduled,
    setShowScheduled,
    selectProject,
    selectSession,
    openSessionById,
    focusScheduledRun,
    createProject,
    renameProject,
    deleteProject,
    startNewChat,
    renameSession,
    forkSession,
    archiveSession,
    archiveProjectSessions,
    unarchiveSession,
    deleteSession,
    sendMessage,
    cancelPending,
    sendPendingNow,
    queueCount,
    interrupt,
    interruptAndClearQueues,
    respondApproval,
    respondDynamicTool,
    respondMcpElicitation,
    respondToolUserInput,
    cancelToolUserInput,
    setGoal,
    clearGoal,
    compactThread,
    reviewUncommitted,
    reviewStart,
    saveSettings,
    setAgentPermissions,
    setSessionModel,
    setSessionEffort,
    draftEffort,
    refresh,
    searchSessions,
    selectDirectory: () => api.selectDirectory(),
    maskApiKey: (k: string) => {
      const v = api.maskApiKey(k);
      return typeof v === 'string' ? v : '••••';
    },
  };
}

export type WorkbenchState = ReturnType<typeof useWorkbench>;

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { SettingsForm } from './components/SettingsForm';
import { SettingsPage } from './components/SettingsPage';
import { PluginsPage } from './components/PluginsPage';
import { ScheduledTasksPage } from './components/ScheduledTasksPage';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { RightPanel, type RightPane } from './components/RightPanel';
import { ApprovalDialog } from './components/ApprovalDialog';
import { DynamicToolDialog } from './components/DynamicToolDialog';
import { ToolUserInputDialog } from './components/ToolUserInputDialog';
import { McpElicitationDialog } from './components/McpElicitationDialog';
import { useWorkbench } from './hooks/useWorkbench';
import { usePreview } from './hooks/usePreview';
import { activeModels, defaultModelId, modelLabelFor } from './types';

const RIGHT_PANEL_WIDTH_KEY = 'cw:right-panel-width';
const RIGHT_PANEL_WIDTH_DEFAULT = 420;
const RIGHT_PANEL_WIDTH_MIN = 280;
/** Leave at least this much for the chat/composer column. */
const MAIN_COLUMN_MIN = 360;

function clampRightPanelWidth(width: number, viewport = window.innerWidth): number {
  const sidebar = 260;
  const max = Math.max(RIGHT_PANEL_WIDTH_MIN, viewport - sidebar - MAIN_COLUMN_MIN);
  return Math.min(max, Math.max(RIGHT_PANEL_WIDTH_MIN, Math.round(width)));
}

function loadRightPanelWidth(): number {
  try {
    const raw = localStorage.getItem(RIGHT_PANEL_WIDTH_KEY);
    const n = raw == null ? NaN : Number(raw);
    if (Number.isFinite(n)) return clampRightPanelWidth(n);
  } catch {
    /* ignore */
  }
  return RIGHT_PANEL_WIDTH_DEFAULT;
}

export default function App() {
  const wb = useWorkbench();
  const [composerInsert, setComposerInsert] = useState<{ key: number; text: string } | null>(
    null,
  );
  const [terminalAlive, setTerminalAlive] = useState(false);
  const [rightPane, setRightPane] = useState<RightPane | null>(null);
  const [rightPanelWidth, setRightPanelWidth] = useState(loadRightPanelWidth);
  const rightResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const onInsertComposer = useCallback(
    (text: string, fromSessionId: string) => {
      const apply = () => setComposerInsert({ key: Date.now(), text });
      if (fromSessionId && fromSessionId !== 'draft' && fromSessionId !== wb.activeSessionId) {
        void wb.selectSession(fromSessionId).then(apply);
        return;
      }
      apply();
    },
    [wb.activeSessionId, wb.selectSession],
  );
  const models = useMemo(() => activeModels(wb.settings), [wb.settings]);
  const selectedModel =
    wb.effectiveSessionModel || defaultModelId(wb.settings) || '';
  const modelLabel = modelLabelFor(wb.settings, selectedModel);
  const preview = usePreview(wb.activeSessionId, onInsertComposer);
  const pluginCwds = useMemo(
    () =>
      wb.projects
        .map((p) => p.workDir)
        .filter((d): d is string => Boolean(d && d.trim())),
    [wb.projects],
  );
  const filesRoot =
    wb.activeProject?.workDir?.trim() ||
    wb.activeSession?.cwd?.trim() ||
    null;
  const filesRootLabel = wb.activeProject?.name || (filesRoot ? '默认工作区' : undefined);

  const rightVisible = rightPane != null;
  // Keep right rail (and TerminalPanel) mounted after first start until explicit close,
  // so hide/show does not spawn a new shell.
  const rightMounted = rightVisible || terminalAlive;

  useEffect(() => {
    if (preview.open) setRightPane('preview');
  }, [preview.open]);

  useEffect(() => {
    const onResize = () => {
      setRightPanelWidth((w) => clampRightPanelWidth(w));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onRightPanelResizePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      rightResizeRef.current = { startX: e.clientX, startWidth: rightPanelWidth };
      document.body.classList.add('resizing-right-panel');
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        const start = rightResizeRef.current;
        if (!start) return;
        // Drag left → wider panel; drag right → narrower.
        const next = clampRightPanelWidth(start.startWidth + (start.startX - ev.clientX));
        setRightPanelWidth(next);
      };
      const onUp = (ev: PointerEvent) => {
        rightResizeRef.current = null;
        document.body.classList.remove('resizing-right-panel');
        try {
          target.releasePointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onUp);
        setRightPanelWidth((w) => {
          try {
            localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(w));
          } catch {
            /* ignore */
          }
          return w;
        });
      };
      target.addEventListener('pointermove', onMove);
      target.addEventListener('pointerup', onUp);
      target.addEventListener('pointercancel', onUp);
    },
    [rightPanelWidth],
  );

  const toggleFiles = () => {
    setRightPane((pane) => (pane === 'files' ? null : 'files'));
  };

  const toggleTerminal = () => {
    // Hide only clears the visible pane; keep TerminalPanel mounted (terminalAlive)
    // so the same PTY is reused. Explicit header "关闭" clears terminalAlive.
    if (rightPane === 'terminal') {
      setRightPane(null);
      return;
    }
    setTerminalAlive(true);
    setRightPane('terminal');
  };

  const togglePreview = () => {
    if (rightPane === 'preview' && preview.open) {
      void preview.close();
      setRightPane(null);
      return;
    }
    if (!preview.open) preview.openPanel();
    setRightPane('preview');
  };

  if (wb.booting) {
    return (
      <div className="onboarding">
        <div className="panel">
          <h1>Codex Work</h1>
          <p>正在加载本地数据…</p>
        </div>
      </div>
    );
  }

  if (!wb.settings) {
    return (
      <div className="onboarding">
        <SettingsForm
          title="欢迎使用 Codex Work"
          subtitle="配置 Provider 后由本机 Codex App Server（JSON-RPC / stdio）驱动。Codex CLI 随本应用从 npm 锁定，无需系统安装。"
          submitLabel="校验并进入"
          onSubmit={wb.saveSettings}
        />
      </div>
    );
  }

  return (
    <div
      className={`app-shell${rightVisible ? ' right-open' : ''}`}
      style={
        rightVisible
          ? ({ ['--right-panel-width' as string]: `${rightPanelWidth}px` } as CSSProperties)
          : undefined
      }
    >
      <Sidebar
        projects={wb.projects}
        sessions={wb.sessions}
        activeProjectId={wb.activeProjectId}
        activeSessionId={wb.activeSessionId}
        modelLabel={modelLabel}
        tokenUsageByThread={wb.tokenUsageByThread}
        onSelectProject={(id) => void wb.selectProject(id)}
        onSelectSession={(id) => void wb.selectSession(id)}
        onCreateProject={wb.createProject}
        onRenameProject={wb.renameProject}
        onDeleteProject={wb.deleteProject}
        onArchiveProjectSessions={wb.archiveProjectSessions}
        onStartNewChat={wb.startNewChat}
        onRenameSession={wb.renameSession}
        onArchiveSession={wb.archiveSession}
        onForkSession={(id) => wb.forkSession(id)}
        onReviewUncommitted={wb.reviewUncommitted}
        onSearchSessions={wb.searchSessions}
        onOpenSettings={() => {
          wb.setShowPlugins(false);
          wb.setShowScheduled(false);
          wb.setShowSettings(true);
        }}
        onOpenPlugins={() => {
          wb.setShowSettings(false);
          wb.setShowScheduled(false);
          wb.setShowPlugins(true);
        }}
        onOpenScheduled={() => {
          wb.setShowSettings(false);
          wb.setShowPlugins(false);
          wb.setShowScheduled(true);
        }}
        selectDirectory={wb.selectDirectory}
        onRefresh={() => void wb.refresh()}
      />

      <ChatArea
        title={wb.activeSession?.title ?? '新对话'}
        messages={wb.messages}
        streamingId={wb.streamingId}
        running={wb.running}
        statusText={wb.statusText}
        error={wb.error ?? preview.error}
        modelLabel={modelLabel}
        models={models}
        selectedModel={selectedModel}
        onSelectModel={wb.setSessionModel}
        onChangeProvider={() => {
          wb.setShowPlugins(false);
          wb.setShowScheduled(false);
          wb.setShowSettings(true);
        }}
        providerCaps={wb.providerCaps}
        effort={wb.draftEffort}
        onSelectEffort={wb.setSessionEffort}
        mentionRoots={[filesRoot].filter((x): x is string => Boolean(x && x.trim()))}
        skillCwds={pluginCwds}
        workspacePath={filesRoot}
        focusKey={wb.composerFocusKey}
        permissions={wb.permissions}
        permissionsBusy={wb.permissionsBusy}
        onPermissionsChange={wb.setAgentPermissions}
        onSend={wb.sendMessage}
        onInterrupt={wb.interrupt}
        onInterruptAndClear={wb.interruptAndClearQueues}
        queueCount={wb.queueCount}
        onCancelPending={wb.cancelPending}
        onSendPendingNow={wb.sendPendingNow}
        onForkFromTurn={async (turnId) => {
          if (!wb.activeSessionId) return;
          await wb.forkSession(wb.activeSessionId, turnId);
        }}
        turnDiff={wb.turnDiff}
        previewOpen={rightPane === 'preview'}
        onTogglePreview={togglePreview}
        terminalOpen={rightPane === 'terminal'}
        onToggleTerminal={toggleTerminal}
        filesOpen={rightPane === 'files'}
        onToggleFiles={toggleFiles}
        composerInsert={composerInsert}
        sessionId={wb.activeSessionId}
        goal={wb.threadGoal}
        tokenUsage={wb.tokenUsage}
        onSetGoal={wb.setGoal}
        onClearGoal={wb.clearGoal}
        onCompact={wb.compactThread}
        onRenameSession={
          wb.activeSessionId
            ? (title) => wb.renameSession(wb.activeSessionId!, title)
            : undefined
        }
        onArchiveSession={
          wb.activeSessionId ? () => wb.archiveSession(wb.activeSessionId!) : undefined
        }
        onForkSession={
          wb.activeSessionId ? () => wb.forkSession(wb.activeSessionId!) : undefined
        }
        onReview={
          wb.activeSessionId
            ? (target, delivery) => wb.reviewStart(target, delivery ?? 'inline', wb.activeSessionId!)
            : undefined
        }
      />

      {rightMounted && (
        <div
          className={rightVisible ? 'right-panel-slot' : 'right-panel-keep-alive'}
          aria-hidden={!rightVisible}
        >
          {rightVisible && (
            <div
              className="right-panel-resize"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整右侧栏宽度"
              aria-valuenow={rightPanelWidth}
              aria-valuemin={RIGHT_PANEL_WIDTH_MIN}
              tabIndex={0}
              onPointerDown={onRightPanelResizePointerDown}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 40 : 16;
                if (e.key === 'ArrowLeft') {
                  e.preventDefault();
                  setRightPanelWidth((w) => {
                    const next = clampRightPanelWidth(w + step);
                    try {
                      localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(next));
                    } catch {
                      /* ignore */
                    }
                    return next;
                  });
                } else if (e.key === 'ArrowRight') {
                  e.preventDefault();
                  setRightPanelWidth((w) => {
                    const next = clampRightPanelWidth(w - step);
                    try {
                      localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(next));
                    } catch {
                      /* ignore */
                    }
                    return next;
                  });
                }
              }}
            />
          )}
          <RightPanel
            pane={rightPane ?? 'terminal'}
            filesRoot={filesRoot}
            filesRootLabel={filesRootLabel}
            onFilesClose={() => setRightPane(null)}
            previewOpen={preview.open}
            previewUrl={preview.url}
            previewPoppedOut={preview.poppedOut}
            onPreviewUrlChange={preview.setUrl}
            onPreviewNavigate={(u) => preview.navigate(u)}
            onPreviewClose={() => {
              void preview.close();
              setRightPane((pane) => (pane === 'preview' ? null : pane));
            }}
            onPreviewPopOut={() => void preview.popOut()}
            terminalAlive={terminalAlive}
            terminalVisible={rightPane === 'terminal'}
            terminalCwd={filesRoot}
            onTerminalHide={() => setRightPane(null)}
            onTerminalClose={() => {
              setTerminalAlive(false);
              setRightPane(null);
            }}
          />
        </div>
      )}

      {wb.showSettings && (
        <div className="settings-overlay">
          <SettingsPage
            initial={wb.settings ?? undefined}
            onSubmit={wb.saveSettings}
            onClose={() => wb.setShowSettings(false)}
            onUnarchiveSession={wb.unarchiveSession}
            onDeleteSession={wb.deleteSession}
          />
        </div>
      )}

      {wb.showPlugins && (
        <div className="settings-overlay">
          <PluginsPage
            onClose={() => wb.setShowPlugins(false)}
            cwds={pluginCwds}
            defaultProjectId={wb.activeProject?.id}
          />
        </div>
      )}

      {wb.showScheduled && (
        <div className="settings-overlay">
          <ScheduledTasksPage
            onClose={() => wb.setShowScheduled(false)}
            onFocusRun={wb.focusScheduledRun}
            projects={wb.projects}
            sessions={wb.sessions}
          />
        </div>
      )}

      {wb.approval && (
        <ApprovalDialog
          request={wb.approval}
          onRespond={(decision, amend) => void wb.respondApproval(decision, amend)}
        />
      )}

      {wb.dynamicToolConfirm && (
        <DynamicToolDialog
          request={wb.dynamicToolConfirm}
          onRespond={(ok) => void wb.respondDynamicTool(ok)}
        />
      )}

      {wb.mcpElicitation && (
        <McpElicitationDialog
          request={wb.mcpElicitation}
          onRespond={(action, content) => void wb.respondMcpElicitation(action, content)}
        />
      )}

      {wb.toolUserInput && (
        <ToolUserInputDialog
          request={wb.toolUserInput}
          onRespond={(answers) => void wb.respondToolUserInput(answers)}
          onCancel={() => void wb.cancelToolUserInput()}
        />
      )}
    </div>
  );
}

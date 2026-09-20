import { useEffect, useRef, useState } from 'react';
import { ask } from '@tauri-apps/plugin-dialog';
import type { ThreadTokenUsage } from '../types';
import {
  contextWindowUsedRatio,
  formatTokenCount,
  tokensInContextWindow,
} from '../types';
import { SessionDynamicToolsPopover } from './SessionDynamicToolsPopover';

interface Props {
  sessionId: string;
  title: string;
  tokenUsage?: ThreadTokenUsage | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  triggerClassName?: string;
  triggerTitle?: string;
  onRename: () => void;
  onArchive: () => void;
  onFork: () => void;
  onReview?: () => void;
}

export function SessionActionsMenu({
  sessionId,
  title,
  tokenUsage,
  open,
  onOpenChange,
  triggerClassName = 'icon-btn session-action',
  triggerTitle = '更多',
  onRename,
  onArchive,
  onFork,
  onReview,
}: Props) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [usageSubmenuOpen, setUsageSubmenuOpen] = useState(false);
  const [toolsSubmenuOpen, setToolsSubmenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuOpen = open ?? uncontrolledOpen;
  const setMenuOpen = onOpenChange ?? setUncontrolledOpen;
  const label = title.trim() || '新对话';
  const contextUsed = tokensInContextWindow(tokenUsage);
  const contextWindow = tokenUsage?.modelContextWindow ?? null;
  const contextRatio = contextWindowUsedRatio(tokenUsage);
  const contextPct = contextRatio != null ? Math.round(contextRatio * 100) : null;
  const sessionTotal = tokenUsage?.total?.totalTokens ?? 0;
  const hasTokenUsage = !!tokenUsage && (contextUsed > 0 || sessionTotal > 0);

  useEffect(() => {
    if (!menuOpen) {
      setUsageSubmenuOpen(false);
      setToolsSubmenuOpen(false);
      return;
    }
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (usageSubmenuOpen) {
        setUsageSubmenuOpen(false);
        return;
      }
      if (toolsSubmenuOpen) {
        setToolsSubmenuOpen(false);
        return;
      }
      setMenuOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, usageSubmenuOpen, toolsSubmenuOpen, setMenuOpen]);

  return (
    <div className={`session-menu${menuOpen ? ' is-open' : ''}`} ref={wrapRef}>
      <button
        type="button"
        className={triggerClassName}
        title={triggerTitle}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen(!menuOpen);
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>
      {menuOpen && (
        <div className="dropdown-menu" role="menu">
          {hasTokenUsage && (
            <div className="dropdown-submenu-wrap">
              <button
                type="button"
                className={`dropdown-item dropdown-submenu-trigger${
                  usageSubmenuOpen ? ' active' : ''
                }`}
                aria-expanded={usageSubmenuOpen}
                aria-haspopup="menu"
                onClick={(e) => {
                  e.stopPropagation();
                  setToolsSubmenuOpen(false);
                  setUsageSubmenuOpen((v) => !v);
                }}
              >
                <span>Token 用量</span>
                <span className="dropdown-submenu-value">
                  {contextPct != null
                    ? `${contextPct}%`
                    : `~${formatTokenCount(sessionTotal || contextUsed)}`}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              </button>
              {usageSubmenuOpen && (
                <div className="dropdown-submenu" role="menu">
                  <div className="dropdown-meta-title">Token 用量</div>
                  {contextPct != null ? (
                    <div className="dropdown-meta-row">
                      <span>上下文</span>
                      <span>{contextPct}%</span>
                    </div>
                  ) : null}
                  <div className="dropdown-meta-row">
                    <span>当前上下文</span>
                    <span>
                      {contextWindow
                        ? `~${formatTokenCount(contextUsed)} / ${formatTokenCount(contextWindow)}`
                        : `~${formatTokenCount(contextUsed)}`}
                    </span>
                  </div>
                  <div className="dropdown-meta-row">
                    <span>本会话累计</span>
                    <span>~{formatTokenCount(sessionTotal)}</span>
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="dropdown-submenu-wrap">
            <button
              type="button"
              className={`dropdown-item dropdown-submenu-trigger${
                toolsSubmenuOpen ? ' active' : ''
              }`}
              aria-expanded={toolsSubmenuOpen}
              aria-haspopup="dialog"
              onClick={(e) => {
                e.stopPropagation();
                setUsageSubmenuOpen(false);
                setToolsSubmenuOpen((v) => !v);
              }}
            >
              <span>本会话工具</span>
              <span className="dropdown-submenu-value">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </button>
            {toolsSubmenuOpen && (
              <div className="dropdown-submenu session-tools-submenu">
                <SessionDynamicToolsPopover
                  threadId={sessionId}
                  open
                  embedded
                  onClose={() => setToolsSubmenuOpen(false)}
                />
              </div>
            )}
          </div>
          {onReview && (
            <button
              type="button"
              className="dropdown-item"
              onClick={() => {
                setMenuOpen(false);
                onReview();
              }}
            >
              Review 未提交更改
            </button>
          )}
          <button
            type="button"
            className="dropdown-item"
            onClick={() => {
              setMenuOpen(false);
              onRename();
            }}
          >
            重命名
          </button>
          <button
            type="button"
            className="dropdown-item"
            onClick={() => {
              setMenuOpen(false);
              onFork();
            }}
          >
            从这里分叉
          </button>
          <button
            type="button"
            className="dropdown-item"
            onClick={() => {
              setMenuOpen(false);
              void (async () => {
                const ok = await ask(`归档会话「${label}」？将从列表中隐藏。`, {
                  title: '归档会话',
                  kind: 'warning',
                });
                if (ok) onArchive();
              })();
            }}
          >
            归档
          </button>
        </div>
      )}
    </div>
  );
}

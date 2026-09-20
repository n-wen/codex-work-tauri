import { useCallback, useEffect, useRef, useState } from 'react';
import { codexApi } from '../api';
import type { GitDiffFile, GitStatus, ReviewTarget } from '../types';

interface Props {
  cwd: string;
  status: GitStatus;
  open: boolean;
  onClose: () => void;
  onReview?: (target: ReviewTarget, delivery: 'inline' | 'detached') => Promise<void>;
  onStatusChange?: () => void;
}

export function GitStatusPopover({
  cwd,
  status,
  open,
  onClose,
  onReview,
  onStatusChange,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [files, setFiles] = useState<GitDiffFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activePath, setActivePath] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewMode, setReviewMode] = useState<'uncommitted' | 'base' | 'commit' | 'custom'>(
    'uncommitted',
  );
  const [baseBranch, setBaseBranch] = useState('main');
  const [commitSha, setCommitSha] = useState('');
  const [customInstructions, setCustomInstructions] = useState('');
  const [delivery, setDelivery] = useState<'inline' | 'detached'>('inline');

  const reload = useCallback(async () => {
    setError(null);
    try {
      const next = await codexApi.getGitDiff(cwd);
      setFiles(next);
      setSelected(new Set(next.map((f) => f.path)));
      setActivePath((prev) => {
        if (prev && next.some((f) => f.path === prev)) return prev;
        return next[0]?.path ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setFiles([]);
    }
  }, [cwd]);

  useEffect(() => {
    if (!open) return;
    void reload();
  }, [open, reload]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const active = files.find((f) => f.path === activePath) ?? null;

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const stageSelected = async () => {
    const paths = [...selected];
    if (!paths.length) return;
    setBusy(true);
    setError(null);
    try {
      await codexApi.gitStage(cwd, paths);
      await reload();
      onStatusChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setBusy(true);
    setError(null);
    try {
      const paths = [...selected];
      if (paths.length) {
        await codexApi.gitStage(cwd, paths);
      }
      await codexApi.gitCommit(cwd, message);
      setMessage('');
      await reload();
      onStatusChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const runReview = async () => {
    if (!onReview) return;
    let target: ReviewTarget;
    if (reviewMode === 'base') {
      const branch = baseBranch.trim();
      if (!branch) {
        setError('请填写基线分支');
        return;
      }
      target = { type: 'baseBranch', branch };
    } else if (reviewMode === 'commit') {
      const sha = commitSha.trim();
      if (!sha) {
        setError('请填写 commit sha');
        return;
      }
      target = { type: 'commit', sha };
    } else if (reviewMode === 'custom') {
      const instructions = customInstructions.trim();
      if (!instructions) {
        setError('请填写 Review 说明');
        return;
      }
      target = { type: 'custom', instructions };
    } else {
      target = { type: 'uncommittedChanges' };
    }
    setBusy(true);
    setError(null);
    try {
      await onReview(target, delivery);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="permissions-popover git-status-popover" ref={ref}>
      <div className="permissions-popover-title">
        Git · {status.branch || '未知分支'}
        {status.dirty ? ' · dirty' : ''}
        {status.ahead > 0 ? ` · ↑${status.ahead}` : ''}
        {status.behind > 0 ? ` · ↓${status.behind}` : ''}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {!files.length ? (
        <div className="empty-hint">工作区干净</div>
      ) : (
        <div className="git-diff-layout">
          <ul className="git-diff-file-list">
            {files.map((f) => (
              <li key={f.path} className={f.path === activePath ? 'active' : ''}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.has(f.path)}
                    onChange={() => toggle(f.path)}
                  />
                  <button type="button" onClick={() => setActivePath(f.path)}>
                    <code>{f.status}</code> {f.path}
                  </button>
                </label>
              </li>
            ))}
          </ul>
          <pre className="approval-diff git-diff-patch">
            {active?.patch?.trim() || '（无 patch）'}
          </pre>
        </div>
      )}

      <div className="provider-row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn" disabled={busy || !selected.size} onClick={() => void stageSelected()}>
          暂存所选
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void reload()}>
          刷新
        </button>
      </div>

      <div className="form-field" style={{ marginTop: 8 }}>
        <label>提交说明</label>
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Commit message"
          disabled={busy}
        />
      </div>
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy || !message.trim()}
        onClick={() => void commit()}
      >
        提交
      </button>

      {onReview && (
        <>
          <div className="permissions-popover-title">Review</div>
          <div className="form-field">
            <label>目标</label>
            <select
              value={reviewMode}
              onChange={(e) =>
                setReviewMode(e.target.value as 'uncommitted' | 'base' | 'commit' | 'custom')
              }
            >
              <option value="uncommitted">未提交更改</option>
              <option value="base">相对基线分支</option>
              <option value="commit">某个 commit</option>
              <option value="custom">自定义说明</option>
            </select>
          </div>
          {reviewMode === 'base' && (
            <div className="form-field">
              <label>基线分支</label>
              <input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} />
            </div>
          )}
          {reviewMode === 'commit' && (
            <div className="form-field">
              <label>commit sha</label>
              <input value={commitSha} onChange={(e) => setCommitSha(e.target.value)} />
            </div>
          )}
          {reviewMode === 'custom' && (
            <div className="form-field">
              <label>说明</label>
              <textarea
                value={customInstructions}
                onChange={(e) => setCustomInstructions(e.target.value)}
                rows={3}
              />
            </div>
          )}
          <label className="approval-check">
            <input
              type="checkbox"
              checked={delivery === 'detached'}
              onChange={(e) => setDelivery(e.target.checked ? 'detached' : 'inline')}
            />
            在新会话中跑（detached）
          </label>
          <button type="button" className="btn" disabled={busy} onClick={() => void runReview()}>
            开始 Review
          </button>
        </>
      )}
    </div>
  );
}

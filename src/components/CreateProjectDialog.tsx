import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, workDir: string) => Promise<void>;
  selectDirectory: () => Promise<string | null>;
}

function folderName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() || path;
}

function IconFolder({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 1 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  );
}

function IconFolderPlus() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
      <path d="M12 11v4M10 13h4" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function IconChevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function CreateProjectDialog({ open, onClose, onCreate, selectDirectory }: Props) {
  const [projectName, setProjectName] = useState('');
  const [workDir, setWorkDir] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameTouched, setNameTouched] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setProjectName('');
    setWorkDir('');
    setCreating(false);
    setError(null);
    setNameTouched(false);
    const id = window.setTimeout(() => nameRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !creating) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, creating, onClose]);

  if (!open) return null;

  const handlePickDir = async () => {
    const dir = await selectDirectory();
    if (!dir) return;
    setWorkDir(dir);
    setError(null);
    if (!nameTouched) {
      setProjectName(folderName(dir));
    }
  };

  const handleCreate = async () => {
    if (!workDir || creating) return;
    setCreating(true);
    setError(null);
    try {
      await onCreate(projectName.trim() || folderName(workDir), workDir);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  return createPortal(
    <div
      className="create-project-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !creating) onClose();
      }}
    >
      <div
        className="create-project-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-project-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="create-project-header">
          <h2 id="create-project-title">创建项目</h2>
          <button
            type="button"
            className="create-project-close"
            title="关闭"
            aria-label="关闭"
            disabled={creating}
            onClick={onClose}
          >
            <IconClose />
          </button>
        </div>

        <label className="create-project-name">
          <span className="create-project-name-icon">
            <IconFolder />
          </span>
          <input
            ref={nameRef}
            value={projectName}
            onChange={(e) => {
              setNameTouched(true);
              setProjectName(e.target.value);
            }}
            placeholder="项目名称"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleCreate();
              }
            }}
          />
        </label>

        <div className="create-project-source-label">源文件夹</div>
        <div className={`create-project-source${workDir ? ' has-folder' : ''}`}>
          <div className="create-project-source-type" aria-hidden="true">
            在此电脑上添加文件夹
            <IconChevron />
          </div>

          {workDir ? (
            <div className="create-project-folder">
              <span className="create-project-folder-icon">
                <IconFolder size={18} />
              </span>
              <span className="create-project-folder-meta">
                <span className="create-project-folder-name">{folderName(workDir)}</span>
                <span className="create-project-folder-path" title={workDir}>
                  {workDir}
                </span>
              </span>
              <button
                type="button"
                className="create-project-folder-remove"
                title="移除"
                aria-label="移除文件夹"
                disabled={creating}
                onClick={() => {
                  setWorkDir('');
                  if (!nameTouched) setProjectName('');
                }}
              >
                <IconClose />
              </button>
            </div>
          ) : null}

          <button
            type="button"
            className="create-project-add"
            disabled={creating}
            onClick={() => void handlePickDir()}
          >
            <IconFolderPlus />
            添加
          </button>
        </div>

        {error ? <div className="create-project-error">{error}</div> : null}

        <div className="create-project-actions">
          <button type="button" className="create-project-cancel" disabled={creating} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="create-project-submit"
            disabled={!workDir || creating}
            onClick={() => void handleCreate()}
          >
            {creating ? '创建中…' : '创建项目'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

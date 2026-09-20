import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { codexApi } from '../api';
import type { DirEntry, FileContent, FuzzySearchHit } from '../types';

interface Props {
  rootPath: string | null;
  rootLabel?: string;
  onClose: () => void;
  embedded?: boolean;
}

interface TreeNode extends DirEntry {
  depth: number;
  children?: TreeNode[];
}

function fileNameOf(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  const idx = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function parentOf(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  const idx = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (idx <= 0) return normalized;
  if (/^[A-Za-z]:\\/.test(normalized) && idx <= 2) return normalized.slice(0, 3);
  return normalized.slice(0, idx);
}

function joinPath(parent: string, name: string): string {
  if (/^[A-Za-z]:[\\/]/.test(parent) || parent.includes('\\')) {
    return `${parent.replace(/[\\/]+$/, '')}\\${name}`;
  }
  return `${parent.replace(/\/+$/, '')}/${name}`;
}

export function FilesPanel({ rootPath, rootLabel, onClose, embedded = false }: Props) {
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [searchHits, setSearchHits] = useState<FuzzySearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  const watchIdRef = useRef<string | null>(null);
  const cacheRef = useRef<Map<string, DirEntry[]>>(new Map());
  const expandedRef = useRef(expanded);
  const searchTimerRef = useRef<number | null>(null);

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  const title = rootLabel || (rootPath ? fileNameOf(rootPath) : '文件');

  const loadDir = useCallback(async (path: string, force = false) => {
    if (!force && cacheRef.current.has(path)) {
      return cacheRef.current.get(path)!;
    }
    const entries = await codexApi.fsReadDirectory(path);
    cacheRef.current.set(path, entries);
    return entries;
  }, []);

  const rebuildTree = useCallback(
    async (root: string, open: Set<string>) => {
      const walk = async (path: string, depth: number): Promise<TreeNode[]> => {
        const entries = await loadDir(path);
        const out: TreeNode[] = [];
        for (const entry of entries) {
          const node: TreeNode = { ...entry, depth };
          if (entry.isDirectory && open.has(entry.path)) {
            node.children = await walk(entry.path, depth + 1);
          }
          out.push(node);
        }
        return out;
      };
      return walk(root, 0);
    },
    [loadDir],
  );

  const refresh = useCallback(
    async (invalidate?: string[]) => {
      if (!rootPath) {
        setNodes([]);
        return;
      }
      if (invalidate?.length) {
        for (const p of invalidate) {
          cacheRef.current.delete(p);
          cacheRef.current.delete(parentOf(p));
        }
      } else {
        cacheRef.current.clear();
      }
      setBusy(true);
      setError(null);
      try {
        setNodes(await rebuildTree(rootPath, expandedRef.current));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [rebuildTree, rootPath],
  );

  useEffect(() => {
    cacheRef.current.clear();
    setExpanded(new Set());
    setSelectedPath(null);
    setPreview(null);
    setQuery('');
    setSearchHits([]);
    setError(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath]);

  useEffect(() => {
    if (!rootPath) return;
    let cancelled = false;
    void (async () => {
      try {
        if (watchIdRef.current) {
          await codexApi.fsUnwatch(watchIdRef.current).catch(() => undefined);
          watchIdRef.current = null;
        }
        const handle = await codexApi.fsWatch(rootPath);
        if (cancelled) {
          await codexApi.fsUnwatch(handle.watchId).catch(() => undefined);
          return;
        }
        watchIdRef.current = handle.watchId;
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      const id = watchIdRef.current;
      watchIdRef.current = null;
      if (id) void codexApi.fsUnwatch(id).catch(() => undefined);
    };
  }, [rootPath]);

  useEffect(() => {
    return codexApi.onEvent((event) => {
      if (event.method !== 'fs/changed') return;
      const watchId =
        typeof event.params.watchId === 'string' ? event.params.watchId : null;
      if (!watchId || watchId !== watchIdRef.current) return;
      const changed = Array.isArray(event.params.changedPaths)
        ? event.params.changedPaths.filter((p): p is string => typeof p === 'string')
        : [];
      void refresh(changed.length ? changed : undefined);
    });
  }, [refresh]);

  useEffect(() => {
    if (!rootPath) {
      setSearchHits([]);
      return;
    }
    const q = query.trim();
    if (!q) {
      setSearchHits([]);
      setSearching(false);
      return;
    }
    if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    setSearching(true);
    searchTimerRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await codexApi.fuzzyFileSearch(q, [rootPath]);
          setSearchHits(result.files.slice(0, 80));
          setError(null);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setSearching(false);
        }
      })();
    }, 220);
    return () => {
      if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    };
  }, [query, rootPath]);

  const flatNodes = useMemo(() => {
    const out: TreeNode[] = [];
    const walk = (list: TreeNode[]) => {
      for (const n of list) {
        out.push(n);
        if (n.children?.length) walk(n.children);
      }
    };
    walk(nodes);
    return out;
  }, [nodes]);

  const toggleDir = async (path: string) => {
    if (!rootPath) return;
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setExpanded(next);
    expandedRef.current = next;
    setBusy(true);
    try {
      setNodes(await rebuildTree(rootPath, next));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const openFile = async (path: string) => {
    setSelectedPath(path);
    setBusy(true);
    setError(null);
    try {
      setPreview(await codexApi.fsReadFile(path));
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onEntryClick = async (entry: DirEntry) => {
    if (entry.isDirectory) {
      await toggleDir(entry.path);
      return;
    }
    await openFile(entry.path);
  };

  const createFolder = async () => {
    if (!rootPath) return;
    const name = window.prompt('新建文件夹名称');
    if (!name?.trim()) return;
    let parent = rootPath;
    if (selectedPath) {
      try {
        const meta = await codexApi.fsGetMetadata(selectedPath);
        parent = meta.isDirectory ? selectedPath : parentOf(selectedPath);
      } catch {
        parent = parentOf(selectedPath);
      }
    }
    const path = joinPath(parent, name.trim());
    try {
      await codexApi.fsCreateDirectory(path, true);
      cacheRef.current.delete(parent);
      await refresh([parent]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const removeSelected = async () => {
    if (!selectedPath || !rootPath || selectedPath === rootPath) return;
    if (!window.confirm(`确定删除？\n${selectedPath}`)) return;
    try {
      await codexApi.fsRemove(selectedPath, true, true);
      if (preview?.path === selectedPath) setPreview(null);
      setSelectedPath(null);
      await refresh([selectedPath]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const revealSelected = async () => {
    const path = selectedPath || rootPath;
    if (!path) return;
    try {
      await revealItemInDir(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const copySelected = async () => {
    if (!selectedPath || !rootPath) return;
    const base = fileNameOf(selectedPath);
    const parent = parentOf(selectedPath);
    const destName = window.prompt('复制为（目标文件名）', `${base}.copy`);
    if (!destName?.trim()) return;
    const dest = joinPath(parent, destName.trim());
    try {
      let recursive = false;
      try {
        const meta = await codexApi.fsGetMetadata(selectedPath);
        recursive = meta.isDirectory;
      } catch {
        /* ignore */
      }
      await codexApi.fsCopy(selectedPath, dest, recursive);
      cacheRef.current.delete(parent);
      await refresh([parent]);
      setSelectedPath(dest);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const openSelectedInEditor = async () => {
    const path = selectedPath || rootPath;
    if (!path) return;
    try {
      await codexApi.openInEditor(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <aside className={`files-panel${embedded ? ' embedded' : ''}`}>
      <header className="files-panel-header">
        <div className="files-panel-title" title={rootPath ?? undefined}>
          <strong>文件</strong>
          <span>{rootPath ? title : '未选择项目'}</span>
        </div>
        <div className="files-panel-actions">
          <button
            type="button"
            className="icon-btn"
            title="刷新"
            disabled={!rootPath || busy}
            onClick={() => void refresh()}
          >
            ↻
          </button>
          <button
            type="button"
            className="icon-btn"
            title="新建文件夹"
            disabled={!rootPath}
            onClick={() => void createFolder()}
          >
            +
          </button>
          <button
            type="button"
            className="icon-btn"
            title="复制/另存"
            disabled={!selectedPath || selectedPath === rootPath}
            onClick={() => void copySelected()}
          >
            ⎘
          </button>
          <button
            type="button"
            className="icon-btn"
            title="在 VS Code 中打开"
            disabled={!rootPath}
            onClick={() => void openSelectedInEditor()}
          >
            ⌨
          </button>
          <button
            type="button"
            className="icon-btn"
            title="在资源管理器中显示"
            disabled={!rootPath}
            onClick={() => void revealSelected()}
          >
            ⌕
          </button>
          <button
            type="button"
            className="icon-btn"
            title="删除"
            disabled={!selectedPath || selectedPath === rootPath}
            onClick={() => void removeSelected()}
          >
            ⌫
          </button>
          <button type="button" className="icon-btn" title="关闭" onClick={onClose}>
            ×
          </button>
        </div>
      </header>

      <div className="files-panel-search">
        <input
          type="search"
          placeholder={rootPath ? '搜索文件…' : '先打开项目'}
          value={query}
          disabled={!rootPath}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {error && <div className="files-panel-error">{error}</div>}

      {!rootPath ? (
        <div className="files-panel-empty">
          当前还没有工作目录。在「最近」里打开已有对话，或先发一条消息（会自动创建默认工作区）。
        </div>
      ) : query.trim() ? (
        <div className="files-panel-list">
          {searching && <div className="files-panel-hint">搜索中…</div>}
          {!searching && !searchHits.length && (
            <div className="files-panel-hint">无匹配结果</div>
          )}
          {searchHits.map((hit) => (
            <button
              key={hit.path}
              type="button"
              className={`files-row${selectedPath === hit.path ? ' selected' : ''}`}
              onClick={() => void openFile(hit.path)}
              title={hit.path}
            >
              <span className="files-icon">
                {hit.matchType === 'directory' ? '📁' : '📄'}
              </span>
              <span className="files-name">{hit.fileName}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="files-panel-list">
          {busy && !flatNodes.length && (
            <div className="files-panel-hint">加载中…</div>
          )}
          {!busy && !flatNodes.length && (
            <div className="files-panel-hint">目录为空</div>
          )}
          {flatNodes.map((node) => (
            <button
              key={node.path}
              type="button"
              className={`files-row${selectedPath === node.path ? ' selected' : ''}`}
              style={{ paddingLeft: 8 + node.depth * 14 }}
              onClick={() => void onEntryClick(node)}
              title={node.path}
            >
              <span className="files-twist">
                {node.isDirectory ? (expanded.has(node.path) ? '▾' : '▸') : ''}
              </span>
              <span className="files-icon">{node.isDirectory ? '📁' : '📄'}</span>
              <span className="files-name">{node.name}</span>
            </button>
          ))}
        </div>
      )}

      {preview && (
        <div className="files-preview">
          <div className="files-preview-header">
            <span title={preview.path}>{fileNameOf(preview.path)}</span>
            <button
              type="button"
              className="icon-btn"
              title="关闭预览"
              onClick={() => setPreview(null)}
            >
              ×
            </button>
          </div>
          {preview.text != null ? (
            <pre className="files-preview-body">{preview.text}</pre>
          ) : (
            <div className="files-panel-hint">
              二进制文件（{preview.byteLength} 字节），无法预览文本。
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

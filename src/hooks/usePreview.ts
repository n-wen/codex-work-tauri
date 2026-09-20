import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { codexApi } from '../api';
import {
  DRAFT_PREVIEW_SESSION,
  formatElementContext,
  isElementSelection,
  isPreviewableUrl,
  newPreviewInstanceId,
  normalizePreviewUrl,
  previewSessionKey,
  previewUrlStorageKey,
} from '../preview';

const DEFAULT_URL = 'http://localhost:5173';

function readStoredUrl(sessionKey: string): string {
  try {
    return (
      localStorage.getItem(previewUrlStorageKey(sessionKey)) ??
      (sessionKey !== DRAFT_PREVIEW_SESSION
        ? localStorage.getItem(previewUrlStorageKey(DRAFT_PREVIEW_SESSION))
        : null) ??
      localStorage.getItem('cw:preview-url') ??
      DEFAULT_URL
    );
  } catch {
    return DEFAULT_URL;
  }
}

export function usePreview(
  activeSessionId: string | null,
  onInsertComposer: (text: string, fromSessionId: string) => void,
) {
  const sessionKey = previewSessionKey(activeSessionId);
  const [openBySession, setOpenBySession] = useState<Record<string, boolean>>({});
  const [urlBySession, setUrlBySession] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [poppedOut, setPoppedOut] = useState(false);
  const sessionKeyRef = useRef(sessionKey);
  const urlBySessionRef = useRef(urlBySession);
  sessionKeyRef.current = sessionKey;
  urlBySessionRef.current = urlBySession;

  const persist = useCallback((key: string, next: string) => {
    const normalized = normalizePreviewUrl(next);
    if (!isPreviewableUrl(normalized)) return;
    setUrlBySession((prev) => {
      if (prev[key] === normalized) return prev;
      return { ...prev, [key]: normalized };
    });
    try {
      localStorage.setItem(previewUrlStorageKey(key), normalized);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void codexApi.setPreviewFocusSession(sessionKey);
  }, [sessionKey]);

  useEffect(() => {
    const stored = readStoredUrl(sessionKey);
    setUrlBySession((prev) => {
      if (prev[sessionKey] != null) return prev;
      return { ...prev, [sessionKey]: stored };
    });
    if (sessionKey !== DRAFT_PREVIEW_SESSION) {
      try {
        const draftKey = previewUrlStorageKey(DRAFT_PREVIEW_SESSION);
        const ownKey = previewUrlStorageKey(sessionKey);
        const draft = localStorage.getItem(draftKey);
        if (draft && !localStorage.getItem(ownKey)) {
          localStorage.setItem(ownKey, draft);
        }
      } catch {
        /* ignore */
      }
    }
  }, [sessionKey]);

  const url = urlBySession[sessionKey] ?? readStoredUrl(sessionKey);
  const open = openBySession[sessionKey] ?? false;

  const setUrl = useCallback(
    (next: string) => {
      setUrlBySession((prev) => ({ ...prev, [sessionKeyRef.current]: next }));
    },
    [],
  );

  const openPanel = useCallback(
    (raw?: string, forSessionId?: string | null) => {
      const key = previewSessionKey(forSessionId ?? sessionKeyRef.current);
      const fallbackUrl = urlBySessionRef.current[key] ?? readStoredUrl(key);
      const hasExplicitUrl = raw != null && raw.trim() !== '';
      const target = normalizePreviewUrl(hasExplicitUrl ? (raw as string) : fallbackUrl);
      if (!isPreviewableUrl(target)) {
        setError('请先提供有效地址，例如 http://127.0.0.1:5173');
        return false;
      }
      persist(key, target);
      setOpenBySession((prev) => ({ ...prev, [key]: true }));
      setError(null);
      setPoppedOut(false);
      return true;
    },
    [persist],
  );

  const close = useCallback(async (forSessionId?: string | null) => {
    const key = previewSessionKey(forSessionId ?? sessionKeyRef.current);
    setOpenBySession((prev) => ({ ...prev, [key]: false }));
    setError(null);
    setPoppedOut(false);
    try {
      await codexApi.closePreviewWindow(key);
    } catch {
      /* ignore if no pop-out */
    }
  }, []);

  const navigate = useCallback(
    (raw: string, forSessionId?: string | null) => {
      const key = previewSessionKey(forSessionId ?? sessionKeyRef.current);
      const target = normalizePreviewUrl(raw);
      if (!isPreviewableUrl(target)) {
        setError('请输入有效的 http(s) 地址');
        return false;
      }
      persist(key, target);
      setOpenBySession((prev) => ({ ...prev, [key]: true }));
      setError(null);
      return true;
    },
    [persist],
  );

  const popOut = useCallback(async () => {
    const key = sessionKeyRef.current;
    const target = normalizePreviewUrl(urlBySessionRef.current[key] ?? readStoredUrl(key));
    if (!isPreviewableUrl(target)) {
      setError('请先提供有效地址');
      return false;
    }
    const instanceId = newPreviewInstanceId();
    try {
      await codexApi.openPreviewWindow(target, key, instanceId, true);
      persist(key, target);
      setPoppedOut(true);
      setError(null);
      return true;
    } catch (e) {
      setError(`无法弹出预览窗口：${String(e)}`);
      return false;
    }
  }, [persist]);

  const toggle = useCallback(() => {
    if (open) void close();
    else openPanel();
  }, [open, close, openPanel]);

  useEffect(() => {
    const offOpened = codexApi.onPreviewOpened(({ url: next, sessionId }) => {
      const target = normalizePreviewUrl(next);
      if (!isPreviewableUrl(target)) {
        setError('Agent 给的预览地址无效，需要 http(s) URL');
        return;
      }
      openPanel(target, sessionId);
    });
    const offClosed = codexApi.onPreviewClosed(({ sessionId }) => {
      void close(sessionId);
    });
    const offWin = codexApi.onPreviewWindowClosed(({ sessionId, url: lastUrl }) => {
      const key = previewSessionKey(sessionId);
      setPoppedOut(false);
      if (lastUrl) persist(key, lastUrl);
      // Keep sidebar panel open when pop-out closes.
      setOpenBySession((prev) => ({ ...prev, [key]: true }));
    });
    const offUrl = codexApi.onPreviewUrlChanged(({ sessionId, url: next }) => {
      persist(previewSessionKey(sessionId), next);
    });
    const offPick = codexApi.onPreviewElementSelected(({ sessionId, data }) => {
      if (!isElementSelection(data)) return;
      onInsertComposer(formatElementContext(data), previewSessionKey(sessionId));
      void getCurrentWindow().setFocus();
    });
    return () => {
      offOpened();
      offClosed();
      offWin();
      offUrl();
      offPick();
    };
  }, [close, onInsertComposer, openPanel, persist]);

  return useMemo(
    () => ({
      open,
      url,
      error,
      poppedOut,
      setUrl,
      navigate,
      toggle,
      openPanel,
      close,
      popOut,
    }),
    [open, url, error, poppedOut, setUrl, navigate, toggle, openPanel, close, popOut],
  );
}

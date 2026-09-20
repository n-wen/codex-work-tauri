import { useCallback, useEffect, useRef, useState } from 'react';

interface Props {
  url: string;
  poppedOut?: boolean;
  embedded?: boolean;
  onUrlChange: (url: string) => void;
  onNavigate: (url: string) => void;
  onClose: () => void;
  onPopOut?: () => void;
}

export function PreviewPanel({
  url,
  poppedOut = false,
  embedded = false,
  onUrlChange,
  onNavigate,
  onClose,
  onPopOut,
}: Props) {
  const [draft, setDraft] = useState(url);
  const [frameKey, setFrameKey] = useState(0);
  const [frameBlocked, setFrameBlocked] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    setDraft(url);
    setFrameBlocked(false);
    setFrameKey((k) => k + 1);
  }, [url]);

  const submit = useCallback(() => {
    const next = draft.trim();
    if (!next) return;
    onNavigate(next);
  }, [draft, onNavigate]);

  const refresh = () => {
    setFrameBlocked(false);
    setFrameKey((k) => k + 1);
  };

  const Tag = embedded ? 'div' : 'aside';

  return (
    <Tag className={`preview-panel${embedded ? ' embedded' : ''}`}>
      <header className="preview-panel-header">
        <button type="button" className="icon-btn" title="后退" onClick={() => {
          try {
            iframeRef.current?.contentWindow?.history.back();
          } catch {
            /* cross-origin */
          }
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
        <button type="button" className="icon-btn" title="前进" onClick={() => {
          try {
            iframeRef.current?.contentWindow?.history.forward();
          } catch {
            /* cross-origin */
          }
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </button>
        <button type="button" className="icon-btn" title="刷新" onClick={refresh}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 12a9 9 0 1 1-2.6-6.4" />
            <path d="M21 3v6h-6" />
          </svg>
        </button>
        <form
          className="preview-panel-url-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            className="preview-panel-url"
            type="text"
            value={draft}
            spellCheck={false}
            placeholder="http://localhost:5173"
            onChange={(e) => {
              setDraft(e.target.value);
              onUrlChange(e.target.value);
            }}
          />
        </form>
        {onPopOut && (
          <button type="button" className="icon-btn" title="弹出独立窗口" onClick={onPopOut}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 3h7v7" />
              <path d="M10 14L21 3" />
              <path d="M21 14v7H3V3h7" />
            </svg>
          </button>
        )}
        {!embedded && (
          <button type="button" className="icon-btn" title="关闭预览" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        )}
      </header>

      <div className="preview-panel-body">
        {poppedOut ? (
          <div className="preview-panel-popped">
            <p>预览已在独立窗口中打开。</p>
            <p>关闭该窗口后会回到侧栏 iframe。</p>
          </div>
        ) : (
          <>
            {frameBlocked && (
              <div className="preview-panel-blocked">
                <p>此页面禁止嵌入（X-Frame-Options / CSP）。</p>
                <p>可改用「弹出独立窗口」打开。</p>
              </div>
            )}
            <iframe
              key={frameKey}
              ref={iframeRef}
              className="preview-panel-frame"
              title="Preview"
              src={url}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
              onLoad={() => {
                try {
                  const doc = iframeRef.current?.contentDocument;
                  if (doc && doc.location.href === 'about:blank') {
                    setFrameBlocked(true);
                  }
                } catch {
                  setFrameBlocked(false);
                }
              }}
              onError={() => setFrameBlocked(true)}
            />
          </>
        )}
      </div>
    </Tag>
  );
}

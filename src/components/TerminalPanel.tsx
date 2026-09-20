import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { codexApi } from '../api';

interface Props {
  cwd?: string | null;
  visible?: boolean;
  onHide: () => void;
  onClose: () => void;
}

interface CommandExecDone {
  processId: string;
  ok: boolean;
  error?: string;
  result?: { exitCode?: number; stdout?: string; stderr?: string };
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): string {
  try {
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return b64;
  }
}

export function TerminalPanel({ cwd, visible = true, onHide, onClose }: Props) {
  const [error, setError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const processIdRef = useRef<string | null>(null);
  const closingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Strict Mode remounts effects once: cleanup must allow a fresh start.
    let cancelled = false;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 13,
      fontFamily: 'Cascadia Code, Consolas, SF Mono, Menlo, ui-monospace, monospace',
      lineHeight: 1.2,
      scrollback: 5000,
      theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
        cursor: '#aeafad',
        selectionBackground: '#264f78',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#e5e5e5',
      },
      allowTransparency: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    term.focus();

    termRef.current = term;
    fitRef.current = fit;

    const onDataDisp = term.onData((data) => {
      const pid = processIdRef.current;
      if (!pid) return;
      void codexApi.commandExecWrite(pid, toBase64(data)).catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    });

    const resize = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      const pid = processIdRef.current;
      const cols = term.cols;
      const rows = term.rows;
      if (!pid || cols < 2 || rows < 1) return;
      void codexApi.commandExecResize(pid, cols, rows).catch(() => undefined);
    };

    const ro = new ResizeObserver(() => resize());
    ro.observe(host);
    window.addEventListener('resize', resize);

    const start = async () => {
      setError(null);
      fit.fit();
      const pid = `term-${Date.now()}`;
      processIdRef.current = pid;
      const shell = navigator.platform.toLowerCase().includes('win')
        ? ['powershell.exe', '-NoLogo']
        : ['/bin/bash', '-l'];
      try {
        await codexApi.commandExec(
          shell,
          cwd ?? null,
          pid,
          true,
          term.cols || 80,
          term.rows || 24,
        );
        // Effect was cleaned up (Strict Mode / unmount) — ignore late success.
        if (cancelled || processIdRef.current !== pid) return;
        term.writeln(`\x1b[90m$ ${shell.join(' ')}\x1b[0m`);
      } catch (err) {
        if (cancelled || processIdRef.current !== pid) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        term.writeln(`\x1b[31m${msg}\x1b[0m`);
        processIdRef.current = null;
      }
    };
    void start();

    return () => {
      cancelled = true;
      onDataDisp.dispose();
      ro.disconnect();
      window.removeEventListener('resize', resize);
      // Drop pid before terminate so commandExecDone from this cleanup
      // does not paint "[进程已退出]" onto the next Strict Mode mount.
      const pid = processIdRef.current;
      processIdRef.current = null;
      if (pid) {
        void codexApi.commandExecTerminate(pid).catch(() => undefined);
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return codexApi.onEvent((event) => {
      if (event.method !== 'command/exec/outputDelta') return;
      const pid = String(event.params.processId ?? '');
      if (!processIdRef.current || pid !== processIdRef.current) return;
      const chunk =
        typeof event.params.deltaBase64 === 'string'
          ? fromBase64(event.params.deltaBase64)
          : typeof event.params.delta === 'string'
            ? event.params.delta
            : '';
      if (chunk) termRef.current?.write(chunk);
    });
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<CommandExecDone>('codex:commandExecDone', (event) => {
      const payload = event.payload;
      if (!payload?.processId || payload.processId !== processIdRef.current) return;
      const term = termRef.current;
      if (!payload.ok) {
        const msg = payload.error ?? '终端已退出';
        setError(msg);
        term?.writeln(`\r\n\x1b[31m${msg}\x1b[0m`);
      } else {
        const code = payload.result?.exitCode;
        term?.writeln(
          code != null
            ? `\r\n\x1b[90m[进程已退出，代码 ${code}]\x1b[0m`
            : '\r\n\x1b[90m[进程已退出]\x1b[0m',
        );
      }
      processIdRef.current = null;
      if (closingRef.current) {
        closingRef.current = false;
        onCloseRef.current();
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // When panel is shown again after hide, refit + focus.
  useEffect(() => {
    if (!visible) return;
    const id = window.setTimeout(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
      const term = termRef.current;
      const pid = processIdRef.current;
      if (term && pid) {
        void codexApi.commandExecResize(pid, term.cols, term.rows).catch(() => undefined);
      }
      term?.focus();
    }, 30);
    return () => window.clearTimeout(id);
  }, [visible]);

  const closeSession = async () => {
    closingRef.current = true;
    const pid = processIdRef.current;
    if (!pid) {
      onClose();
      return;
    }
    try {
      await codexApi.commandExecTerminate(pid);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      processIdRef.current = null;
      closingRef.current = false;
      onClose();
    }
  };

  return (
    <div className="terminal-dock">
      <div className="terminal-dock-header">
        <div className="terminal-dock-title">
          <span>终端</span>
          {cwd && <span className="terminal-dock-cwd" title={cwd}>{cwd}</span>}
        </div>
        <div className="terminal-panel-actions">
          <button type="button" className="icon-btn terminal-dock-btn" title="隐藏终端" onClick={onHide}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M5 12h14" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className="icon-btn terminal-dock-btn"
            title="关闭终端"
            onClick={() => void closeSession()}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
      {error && <div className="terminal-dock-error">{error}</div>}
      <div
        ref={hostRef}
        className="terminal-xterm"
        onClick={() => termRef.current?.focus()}
      />
    </div>
  );
}

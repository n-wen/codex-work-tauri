import type { ThreadTokenUsage, TokenUsageBreakdown } from '../types';
import {
  contextWindowUsedRatio,
  tokensInContextWindow,
} from '../types';

interface Props {
  open: boolean;
  usage: ThreadTokenUsage | null;
  busy?: boolean;
  onClose: () => void;
  onCompact: () => void;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}K`;
  }
  const m = n / 1_000_000;
  return `${m.toFixed(m >= 10 ? 0 : 1).replace(/\.0$/, '')}M`;
}

const SEGMENTS: { key: keyof TokenUsageBreakdown; label: string; color: string }[] = [
  { key: 'cachedInputTokens', label: '缓存输入', color: '#9ca3af' },
  { key: 'inputTokens', label: '输入', color: '#8b5cf6' },
  { key: 'outputTokens', label: '输出', color: '#f59e0b' },
  { key: 'reasoningOutputTokens', label: '推理输出', color: '#22c55e' },
];

export function ContextUsagePopover({ open, usage, busy, onClose, onCompact }: Props) {
  if (!open) return null;

  // Context fill uses `last` (current window occupancy), not cumulative `total`.
  const last = usage?.last ?? null;
  const sessionTotal = usage?.total ?? null;
  const windowSize = usage?.modelContextWindow ?? null;
  const contextUsed = tokensInContextWindow(usage);
  const ratio = contextWindowUsedRatio(usage);
  const pct = ratio != null ? Math.round(ratio * 100) : null;
  const inputFresh = last ? Math.max(0, last.inputTokens - last.cachedInputTokens) : 0;
  const barParts = last
    ? [
        { label: '缓存输入', value: last.cachedInputTokens, color: '#9ca3af' },
        { label: '输入', value: inputFresh, color: '#8b5cf6' },
        { label: '输出', value: last.outputTokens, color: '#f59e0b' },
        { label: '推理输出', value: last.reasoningOutputTokens, color: '#22c55e' },
      ]
    : [];
  const denom = windowSize && windowSize > 0 ? windowSize : Math.max(contextUsed, 1);

  return (
    <div className="permissions-popover context-usage-popover" role="dialog" aria-label="上下文用量">
      <div className="session-tools-popover-header">
        <strong>上下文用量</strong>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          关闭
        </button>
      </div>

      <div className="context-usage-meta">
        <span>{pct != null ? `${pct}% 已用` : contextUsed ? '最近一轮上下文' : '暂无用量'}</span>
        <span>
          {usage
            ? windowSize
              ? `~${formatTokens(contextUsed)} / ${formatTokens(windowSize)}`
              : `~${formatTokens(contextUsed)} tokens`
            : '完成一轮后更新'}
        </span>
      </div>

      <div className="context-usage-bar" aria-hidden>
        {barParts.map((part) => {
          const width = (part.value / denom) * 100;
          if (width <= 0) return null;
          return (
            <span
              key={part.label}
              style={{ width: `${width}%`, background: part.color }}
              title={`${part.label} ${formatTokens(part.value)}`}
            />
          );
        })}
      </div>

      {last ? (
        <ul className="context-usage-list">
          {SEGMENTS.map((seg) => {
            const value = seg.key === 'inputTokens' ? inputFresh : last[seg.key];
            return (
              <li key={seg.key}>
                <span>
                  <i style={{ background: seg.color }} />
                  {seg.label}
                </span>
                <span>{formatTokens(value)}</span>
              </li>
            );
          })}
          <li className="context-usage-total">
            <span>当前上下文</span>
            <span>{formatTokens(contextUsed)}</span>
          </li>
          {sessionTotal ? (
            <li>
              <span>本会话累计</span>
              <span>{formatTokens(sessionTotal.totalTokens)}</span>
            </li>
          ) : null}
        </ul>
      ) : null}

      <button
        type="button"
        className="btn btn-primary context-usage-compact"
        disabled={busy}
        onClick={onCompact}
      >
        {busy ? '正在压缩…' : '压缩上下文'}
      </button>
    </div>
  );
}

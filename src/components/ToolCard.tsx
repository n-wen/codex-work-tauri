import { useState } from 'react';
import type { ToolCallRecord } from '../types';

const STATUS_LABEL: Record<ToolCallRecord['status'], string> = {
  pending_approval: '待批准',
  running: '执行中',
  completed: '',
  rejected: '已拒绝',
  error: '错误',
};

const TOOL_LABEL: Record<ToolCallRecord['name'], string> = {
  run_command: '已运行命令',
  list_dir: '已列出目录',
  read_file: '已读取文件',
  write_file: '已写入文件',
};

function ToolIcon({ name }: { name: ToolCallRecord['name'] }) {
  if (name === 'run_command') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M7 9l3 3-3 3" />
        <path d="M12 15h5" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

function summarize(tool: ToolCallRecord): string {
  const args = tool.arguments ?? {};
  if (tool.name === 'run_command') {
    const cmd = String(args.command ?? args.cmd ?? '');
    return cmd ? `${TOOL_LABEL[tool.name]} · ${cmd}` : TOOL_LABEL[tool.name];
  }
  if (tool.name === 'read_file' || tool.name === 'write_file') {
    const path = String(args.path ?? args.file ?? '');
    return path ? `${TOOL_LABEL[tool.name]} · ${path}` : TOOL_LABEL[tool.name];
  }
  if (tool.name === 'list_dir') {
    const path = String(args.path ?? args.dir ?? '.');
    return `${TOOL_LABEL[tool.name]} · ${path}`;
  }
  return TOOL_LABEL[tool.name];
}

export function ToolCard({ tool }: { tool: ToolCallRecord }) {
  const streaming = tool.name === 'run_command' && tool.status === 'running' && !!tool.result;
  const [open, setOpen] = useState(false);
  const status = STATUS_LABEL[tool.status];
  const detail =
    tool.diffSummary ||
    tool.result ||
    tool.error ||
    JSON.stringify(tool.arguments, null, 2);
  const showDetail = open || streaming;

  return (
    <div style={{ width: '100%' }}>
      <button
        type="button"
        className={`tool-pill ${tool.status}`}
        onClick={() => setOpen((v) => !v)}
        title="查看详情"
      >
        <span className="tool-pill-icon">
          <ToolIcon name={tool.name} />
        </span>
        <span className="tool-pill-label">{summarize(tool)}</span>
        {status ? <span className="tool-pill-status">{status}</span> : null}
      </button>
      {showDetail && (
        <div className={`tool-detail${tool.name === 'run_command' ? ' terminal' : ''}`}>
          {detail}
        </div>
      )}
    </div>
  );
}

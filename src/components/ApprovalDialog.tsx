import { useMemo, useState } from 'react';
import type {
  ApprovalDecision,
  ApprovalNetworkAmendment,
  ApprovalRequest,
} from '../types';

interface Props {
  request: ApprovalRequest;
  onRespond: (
    decision: ApprovalDecision,
    applyNetworkAmendment?: ApprovalNetworkAmendment | null,
  ) => void;
}

function formatChanges(request: ApprovalRequest): string | null {
  if (request.diffSummary?.trim()) return request.diffSummary.trim();
  const changes = request.arguments?.changes;
  if (!Array.isArray(changes) || !changes.length) return null;
  return changes
    .map((c) => {
      if (!c || typeof c !== 'object') return '';
      const path = String((c as { path?: unknown }).path ?? '');
      const diff = String((c as { diff?: unknown }).diff ?? '');
      return path ? `${path}\n${diff}` : diff;
    })
    .filter(Boolean)
    .join('\n\n');
}

function formatCommandAction(action: unknown): string {
  if (!action || typeof action !== 'object') return String(action ?? '');
  const a = action as Record<string, unknown>;
  const type = String(a.type ?? '');
  const command = typeof a.command === 'string' ? a.command : '';
  const path = typeof a.path === 'string' ? a.path : '';
  const name = typeof a.name === 'string' ? a.name : '';
  switch (type) {
    case 'read':
      return `读取 ${path || name || command}`;
    case 'listFiles':
      return `列出 ${path || command || '.'}`;
    case 'search':
      return `搜索 ${command || path || name}`;
    case 'write':
      return `写入 ${path || command}`;
    case 'unknown':
      return command || '未知动作';
    default:
      return [type, command || path || name].filter(Boolean).join(' · ') || JSON.stringify(a);
  }
}

function summarizePermissions(raw: unknown): { paths: string[]; network: boolean } {
  if (!raw || typeof raw !== 'object') return { paths: [], network: false };
  const p = raw as {
    fileSystem?: { read?: string[]; write?: string[]; entries?: unknown[] };
    network?: { enabled?: boolean | null };
  };
  const paths: string[] = [];
  for (const x of p.fileSystem?.read ?? []) paths.push(`读 ${x}`);
  for (const x of p.fileSystem?.write ?? []) paths.push(`写 ${x}`);
  for (const e of p.fileSystem?.entries ?? []) {
    if (!e || typeof e !== 'object') continue;
    const entry = e as { access?: string; path?: { type?: string; path?: string; pattern?: string } };
    const access = entry.access ?? '?';
    const pathObj = entry.path;
    const label =
      pathObj?.type === 'glob_pattern'
        ? pathObj.pattern
        : pathObj?.type === 'path'
          ? pathObj.path
          : JSON.stringify(pathObj);
    if (label) paths.push(`${access} ${label}`);
  }
  return { paths, network: !!p.network?.enabled };
}

export function ApprovalDialog({ request, onRespond }: Props) {
  const diff = request.name === 'write_file' ? formatChanges(request) : null;
  const isPermissions = request.kind === 'permissions' || request.name === 'permissions';
  const isCommand = request.name === 'run_command' || request.kind === 'command';
  const networkAmendments = request.proposedNetworkPolicyAmendments ?? [];
  const [applyNetwork, setApplyNetwork] = useState(networkAmendments.length > 0);
  const selectedNetwork = networkAmendments[0] ?? null;

  const permSummary = useMemo(
    () => summarizePermissions(request.permissions ?? request.arguments?.permissions),
    [request.permissions, request.arguments],
  );

  const title = isPermissions
    ? '额外权限请求'
    : request.name === 'write_file'
      ? '写入文件确认'
      : '命令执行确认';

  return (
    <div className="modal-backdrop">
      <div className="approval-box">
        <h3>{title}</h3>
        <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>{request.reason}</p>

        {isCommand && !!request.commandActions?.length && (
          <div className="approval-section">
            <div className="approval-section-title">解析动作</div>
            <ul className="approval-actions">
              {request.commandActions.map((a, i) => (
                <li key={i}>{formatCommandAction(a)}</li>
              ))}
            </ul>
          </div>
        )}

        {isCommand && request.arguments?.command != null && (
          <pre className="approval-diff">{String(request.arguments.command)}</pre>
        )}

        {diff && <pre className="approval-diff">{diff}</pre>}

        {isPermissions && (
          <div className="approval-section">
            {permSummary.network && (
              <div className="approval-pill">请求开启网络</div>
            )}
            {!!permSummary.paths.length && (
              <ul className="approval-actions">
                {permSummary.paths.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            {!permSummary.network && !permSummary.paths.length && (
              <pre>{JSON.stringify(request.permissions ?? request.arguments, null, 2)}</pre>
            )}
          </div>
        )}

        {!isCommand && !diff && !isPermissions && (
          <pre>{JSON.stringify(request.arguments, null, 2)}</pre>
        )}

        {!!selectedNetwork && (
          <label className="approval-check">
            <input
              type="checkbox"
              checked={applyNetwork}
              onChange={(e) => setApplyNetwork(e.target.checked)}
            />
            同时允许网络：{selectedNetwork.action} {selectedNetwork.host}
          </label>
        )}

        {!!request.proposedExecpolicyAmendment?.length && (
          <div className="approval-section-hint">
            本会话记住后可跳过类似命令（{request.proposedExecpolicyAmendment.join(', ')}）
          </div>
        )}

        <div className="panel-actions approval-actions-row">
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => onRespond('cancel')}
            title="拒绝并中断整轮"
          >
            拒绝并取消整轮
          </button>
          <button type="button" className="btn" onClick={() => onRespond('decline')}>
            拒绝
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              onRespond(
                'acceptForSession',
                applyNetwork && selectedNetwork ? selectedNetwork : null,
              )
            }
          >
            本会话记住
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() =>
              onRespond('accept', applyNetwork && selectedNetwork ? selectedNetwork : null)
            }
          >
            {isPermissions ? '允许这些权限' : '允许'}
          </button>
        </div>
      </div>
    </div>
  );
}

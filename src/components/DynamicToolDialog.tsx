import type { DynamicToolConfirmRequest } from '../types';

interface Props {
  request: DynamicToolConfirmRequest;
  onRespond: (allowed: boolean) => void;
}

export function DynamicToolDialog({ request, onRespond }: Props) {
  const title = request.namespace
    ? `${request.namespace}.${request.tool}`
    : request.tool;

  return (
    <div className="modal-backdrop">
      <div className="approval-box">
        <h3>桌面工具确认</h3>
        <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
          Agent 请求调用 <strong>{title}</strong>
        </p>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{request.summary}</pre>
        <details>
          <summary>参数</summary>
          <pre>{JSON.stringify(request.arguments, null, 2)}</pre>
        </details>
        <div className="panel-actions">
          <button type="button" className="btn btn-danger" onClick={() => onRespond(false)}>
            拒绝
          </button>
          <button type="button" className="btn btn-primary" onClick={() => onRespond(true)}>
            允许
          </button>
        </div>
      </div>
    </div>
  );
}

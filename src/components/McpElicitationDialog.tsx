import type { McpElicitationRequest } from '../types';

interface Props {
  request: McpElicitationRequest;
  onRespond: (action: 'accept' | 'decline' | 'cancel', content?: unknown) => void;
}

export function McpElicitationDialog({ request, onRespond }: Props) {
  return (
    <div className="modal-backdrop">
      <div className="approval-box">
        <h3>MCP 需要输入</h3>
        <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
          {request.serverName ? `${request.serverName} · ` : ''}
          {request.message}
        </p>
        {request.mode === 'url' && request.url && (
          <p className="form-hint">
            请在浏览器完成：{' '}
            <a href={request.url} target="_blank" rel="noreferrer">
              {request.url}
            </a>
          </p>
        )}
        {request.schema != null && (
          <pre className="approval-diff">{JSON.stringify(request.schema, null, 2)}</pre>
        )}
        <div className="panel-actions approval-actions-row">
          <button type="button" className="btn btn-danger" onClick={() => onRespond('cancel')}>
            取消
          </button>
          <button type="button" className="btn" onClick={() => onRespond('decline')}>
            拒绝
          </button>
          <button type="button" className="btn btn-primary" onClick={() => onRespond('accept')}>
            接受
          </button>
        </div>
      </div>
    </div>
  );
}

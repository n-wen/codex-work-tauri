import { FilesPanel } from './FilesPanel';
import { PreviewPanel } from './PreviewPanel';
import { TerminalPanel } from './TerminalPanel';

export type RightPane = 'files' | 'preview' | 'terminal';

interface Props {
  pane: RightPane;
  filesRoot: string | null;
  filesRootLabel?: string;
  onFilesClose: () => void;

  previewOpen: boolean;
  previewUrl: string;
  previewPoppedOut?: boolean;
  onPreviewUrlChange: (url: string) => void;
  onPreviewNavigate: (url: string) => void;
  onPreviewClose: () => void;
  onPreviewPopOut?: () => void;

  terminalAlive: boolean;
  terminalVisible: boolean;
  terminalCwd?: string | null;
  onTerminalHide: () => void;
  onTerminalClose: () => void;
}

export function RightPanel({
  pane,
  filesRoot,
  filesRootLabel,
  onFilesClose,
  previewOpen,
  previewUrl,
  previewPoppedOut,
  onPreviewUrlChange,
  onPreviewNavigate,
  onPreviewClose,
  onPreviewPopOut,
  terminalAlive,
  terminalVisible,
  terminalCwd,
  onTerminalHide,
  onTerminalClose,
}: Props) {
  return (
    <aside className="right-panel">
      <div className={`right-panel-pane${pane === 'files' ? ' active' : ''}`} hidden={pane !== 'files'}>
        <FilesPanel
          rootPath={filesRoot}
          rootLabel={filesRootLabel}
          onClose={onFilesClose}
          embedded
        />
      </div>

      <div className={`right-panel-pane${pane === 'preview' ? ' active' : ''}`} hidden={pane !== 'preview'}>
        {previewOpen ? (
          <PreviewPanel
            url={previewUrl}
            poppedOut={previewPoppedOut}
            onUrlChange={onPreviewUrlChange}
            onNavigate={onPreviewNavigate}
            onClose={onPreviewClose}
            onPopOut={onPreviewPopOut}
            embedded
          />
        ) : (
          <div className="right-panel-empty">
            <p>预览未打开</p>
          </div>
        )}
      </div>

      <div
        className={`right-panel-pane${pane === 'terminal' ? ' active' : ''}`}
        hidden={pane !== 'terminal'}
      >
        {terminalAlive ? (
          <TerminalPanel
            cwd={terminalCwd}
            visible={terminalVisible}
            onHide={onTerminalHide}
            onClose={onTerminalClose}
          />
        ) : (
          <div className="right-panel-empty">
            <p>终端未启动</p>
          </div>
        )}
      </div>
    </aside>
  );
}

import type { ConnectionCapabilities } from '../../../shared/ipc-contract';
import { FileBrowser } from '../../files/FileBrowser';
import { FolderIcon } from '../Icons';

/**
 * The files page: transfer files with a live session.
 *
 * ── why it needs a **session**, not a profile ──
 *
 * The host keys its connection table by **session id** (`terminal:open`
 * creates one connection per session), and `files:list` / `files:push` /
 * `files:pull` take that id. So a file transfer needs an open terminal
 * session — which is why the sidebar lists sessions under "objects".
 */
export function FilesPage({
  sessionId,
  capabilities,
  onPush,
  onPull,
  note,
}: {
  /** The session the transfer runs through (null = none open yet). */
  sessionId: string | null;
  capabilities: ConnectionCapabilities | null;
  onPush: (file: File, remotePath: string) => void;
  onPull: (connectionId: string, remotePath: string) => void;
  note?: string | null;
}): JSX.Element {
  const ready = sessionId !== null && capabilities !== null;
  return (
    <div className="page page--files">
      <header className="page-head">
        <div className="page-head__text">
          <span className="page-head__eyebrow">FILES</span>
          <h1 className="page-head__title">文件传输</h1>
          <p className="page-head__sub">
            {ready
              ? '本地 ↔ 板端 · 通过当前终端连接传输'
              : '传输要走一个终端连接：先在终端页开一个'}
          </p>
        </div>
        <div className="page-head__actions">
          {note ? <span className="page-head__note">{note}</span> : null}
        </div>
      </header>

      {ready ? (
        <div className="files-stage">
          <FileBrowser
            connectionId={sessionId}
            capabilities={capabilities}
            listRemote={(connectionId, remotePath) =>
              window.cockpit.filesList(connectionId, remotePath)
            }
            onPush={onPush}
            onPull={onPull}
          />
        </div>
      ) : (
        <div className="page-empty">
          <span className="page-empty__icon" aria-hidden>
            <FolderIcon size={26} />
          </span>
          <h2>还没有可传输的会话</h2>
          <p>在终端页开一个连接，回到这里就能看到两端的文件树。</p>
          <p className="dim">串口 / ADB / SSH：传输需要连接背后的文件能力。</p>
        </div>
      )}
    </div>
  );
}

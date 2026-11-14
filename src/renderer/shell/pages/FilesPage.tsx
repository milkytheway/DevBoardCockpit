import type { ConnectionCapabilities } from '../../../shared/ipc-contract';
import { FileBrowser } from '../../files/FileBrowser';

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
  if (sessionId === null || capabilities === null) {
    return (
      <div className="page page--files is-empty">
        <p className="files__empty">
          文件传输需要一个开着的会话。左边「对象」里选一个会话，或者先去终端开一个。
        </p>
      </div>
    );
  }
  return (
    <div className="page page--files">
      <FileBrowser
        connectionId={sessionId}
        capabilities={capabilities}
        listRemote={(connectionId, remotePath) => window.cockpit.filesList(connectionId, remotePath)}
        onPush={onPush}
        onPull={onPull}
      />
      {note ? <p className="files__note">{note}</p> : null}
    </div>
  );
}

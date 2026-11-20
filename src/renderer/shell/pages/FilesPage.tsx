import type { ConnectionCapabilities } from '../../../shared/ipc-contract';
import { FileBrowser } from '../../files/FileBrowser';
import { useT, type Localised } from '../i18n';
import { FolderIcon } from '../Icons';

/**
 * **Interface wording** —— every string the user can read is in this table ✓.
 *
 * Each entry sits next to the code that uses it, and `t()` picks the one for
 * the active locale ✓.
 */
const strings = {
  title: { 'zh-Hans': '文件传输', en: 'File transfer' },
  readySubtitle: {
    'zh-Hans': '本地 ↔ 板端 · 通过当前终端连接传输',
    en: 'Local ↔ board · through the current terminal connection',
  },
  notReadySubtitle: {
    'zh-Hans': '传输要走一个终端连接：先在终端页开一个',
    en: 'A transfer needs a terminal connection: open one on the terminal page first',
  },
  emptyTitle: { 'zh-Hans': '还没有可传输的会话', en: 'No session to transfer with yet' },
  emptyBody: {
    'zh-Hans': '在终端页开一个连接，回到这里就能看到两端的文件树。',
    en: 'Open a connection on the terminal page and both file trees show up here.',
  },
  emptyNote: {
    'zh-Hans': '串口 / ADB / SSH：传输需要连接背后的文件能力。',
    en: 'Serial / ADB / SSH: a transfer needs the file capability behind the connection.',
  },
} satisfies Record<string, Localised>;

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
  const t = useT();
  const ready = sessionId !== null && capabilities !== null;
  return (
    <div className="page page--files">
      <header className="page-head">
        <div className="page-head__text">
          <span className="page-head__eyebrow">FILES</span>
          <h1 className="page-head__title">{t(strings.title)}</h1>
          <p className="page-head__sub">
            {ready ? t(strings.readySubtitle) : t(strings.notReadySubtitle)}
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
          <h2>{t(strings.emptyTitle)}</h2>
          <p>{t(strings.emptyBody)}</p>
          <p className="dim">{t(strings.emptyNote)}</p>
        </div>
      )}
    </div>
  );
}
import type { FileEndpointInfo } from '../../../shared/ipc-contract';
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
    'zh-Hans': '已连接 · {link}',
    en: 'Connected · {link}',
  },
  connectingSubtitle: {
    'zh-Hans': '正在连接…',
    en: 'Connecting…',
  },
  notReadySubtitle: {
    'zh-Hans': '未连接开发板',
    en: 'No board connected',
  },
  emptyTitle: { 'zh-Hans': '还没有可传输的连接', en: 'No link to transfer with yet' },
  failedTitle: { 'zh-Hans': '没有一条通道能用', en: 'No link works' },
  retry: { 'zh-Hans': '再找一次', en: 'Look again' },
} satisfies Record<string, Localised>;

/**
 * The files page: transfer files with the link the host picked.
 *
 * ── why it does **not** need a terminal session ──
 *
 * → The host keeps its connections by session id ✓ — the page used to ask
 *   the terminal for one ✓ → **the page was empty until the user opened a
 *   terminal** ✗ ("the files are empty" ✓).
 * → Now **the host picks the link** ✓ (ADB → SSH → serial ✓) and the page
 *   only uses it ✓ — **no terminal, no session, no waiting** ✓.
 */
export function FilesPage({
  endpoint,
  busy,
  error,
  onPush,
  onPull,
  onRetry,
  note,
}: {
  /** The link the host picked ✓ (`null` = there is none ✓) */
  endpoint: FileEndpointInfo | null;
  /** Is the host looking for one? ✓ */
  busy: boolean;
  /** Why there is none ✓ (the host said why ✓) */
  error: string | null;
  onPush: (file: File, remotePath: string) => void;
  onPull: (connectionId: string, remotePath: string) => void;
  /** Look for a link again ✓ (the board may have been plugged in ✓) */
  onRetry?: () => void;
  note?: string | null;
}): JSX.Element {
  const t = useT();
  const ready = endpoint !== null;
  const subtitle = (): string => {
    if (busy) return t(strings.connectingSubtitle);
    if (ready) {
      return t(strings.readySubtitle, { link: `${endpoint.label} · ${endpoint.transport}` });
    }
    return t(strings.notReadySubtitle);
  };
  return (
    <div className="page page--files">
      <header className="page-head">
        <div className="page-head__text">
          <span className="page-head__eyebrow">FILES</span>
          <h1 className="page-head__title">{t(strings.title)}</h1>
          <p className="page-head__sub">{subtitle()}</p>
        </div>
        <div className="page-head__actions">
          {note ? <span className="page-head__note">{note}</span> : null}
          {error !== null ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={onRetry}>
              {t(strings.retry)}
            </button>
          ) : null}
        </div>
      </header>

      {ready ? (
        <div className="files-stage">
          <FileBrowser
            connectionId={endpoint.id}
            capabilities={endpoint.capabilities}
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
          <h2>{error !== null ? t(strings.failedTitle) : t(strings.emptyTitle)}</h2>
          {error !== null ? <p className="dim">{error}</p> : null}
        </div>
      )}
    </div>
  );
}

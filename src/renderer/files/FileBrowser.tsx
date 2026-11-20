import { useCallback, useRef, useState } from 'react';
import type { ConnectionCapabilities } from '../../shared/ipc-contract';
import { useT, type Localised } from '../shell/i18n';

/**
 * The dual-tree file browser.
 *
 * The interaction follows the predecessor project: **keep the interaction
 * design, rewrite the implementation** — a dual tree, lazy loading, a target
 * selector and arrow transfers:
 *
 * ```
 *   local                       remote
 *  ┌──────────┐  ↑upload  ↓download ┌──────────┐
 *  │  file tree│                │  file tree│
 *  └──────────┘                └──────────┘
 * ```
 *
 * **The remote tree is lazy**: a directory has to be asked of the host, and
 * that must not happen while rendering. The listing is fetched when the user
 * asks for it.
 *
 * **A serial line has no file channel** (device fact S7): when
 * `capabilities.files === false`, neither arrow is offered and a single line of
 * explanation is left instead — without an entry point the user learns that
 * this line does not support it, instead of thinking the feature is broken.
 */

/** The wording of the browser, in both languages. */
const strings = {
  noFileChannel: {
    'zh-Hans': '这个连接不能传文件（串口没有文件通道）',
    en: 'This connection cannot carry files (a serial port has no file channel)',
  },
  local: { 'zh-Hans': '本地', en: 'Local' },
  chooseFile: { 'zh-Hans': '选文件（可拖进来）', en: 'Choose a file (or drop one here)' },
  noneSelected: { 'zh-Hans': '未选择', en: 'Nothing selected' },
  upload: { 'zh-Hans': '上传到远端', en: 'Upload to the remote' },
  download: { 'zh-Hans': '从远端下载', en: 'Download from the remote' },
  up: { 'zh-Hans': '上一级', en: 'One level up' },
  refresh: { 'zh-Hans': '刷新', en: 'Refresh' },
  refreshHint: {
    'zh-Hans': '点「刷新」看远端目录',
    en: 'Press "Refresh" to list the remote directory',
  },
} satisfies Record<string, Localised>;

/** One entry of a remote directory (the same shape as `FileEntry` in `shared/ipc-contract`) */
export interface RemoteEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  sizeBytes: number | null;
  modifiedAt: string | null;
}

export interface FileBrowserProps {
  connectionId: string;
  capabilities: ConnectionCapabilities;
  /** Upload: a local file → the remote directory */
  onPush: (file: File, remotePath: string) => void;
  /** Download: remote → local */
  onPull: (connectionId: string, remotePath: string) => void;
  /** Lists a remote directory. The host runs the transfer */
  listRemote: (connectionId: string, remotePath: string) => Promise<RemoteEntry[]>;
  /** The current remote directory; the root by default */
  remotePath?: string;
}

/**
 * The parent directory.
 *
 * A remote path is normally POSIX (`/root/sub`), but a **local target** gives
 * a Windows path (`C:\Users\me`) — so both separators have to be recognised.
 */
export function parentPath(path: string): string {
  const m = /^(.*?)[\\/][^\\/]+[\\/]*$/.exec(path);
  if (!m) return path;
  // m[1] 为空 = 路径在根下（`/.cache`）→ 上一级是根
  if (m[1] === '') return '/';
  // Windows 的盘符根（`C:\Users` → `C:\`）
  if (/^[A-Za-z]:$/.test(m[1])) return `${m[1]}\\`;
  return m[1];
}

export function FileBrowser({
  connectionId,
  capabilities,
  onPush,
  onPull,
  listRemote,
  remotePath = '/',
}: FileBrowserProps): JSX.Element {
  const [remote, setRemote] = useState<RemoteEntry[]>([]);
  const [selectedRemote, setSelectedRemote] = useState<RemoteEntry | null>(null);
  const [selectedLocal, setSelectedLocal] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The remote directory the browser is in.
   *
   * **The remote tree has to be navigable** — otherwise the user only ever
   * sees the root directory and "upload into a directory" is not even a
   * thing that can be asked for. (`remotePath` used to be a constant prop
   * that the component never changed, so clicking a directory selected it
   * instead of entering it.)
   */
  const [currentPath, setCurrentPath] = useState(remotePath);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** The sequence number of the last listing request (used to drop stale responses) */
  const loadSeq = useRef(0);
  const t = useT();

  /**
   * Lists a directory.
   *
   * **The path is the source of truth and the listing follows it** — entering a
   * directory and going back up both list again, otherwise the path has
   * changed while the listing still shows the previous directory.
   */
  const load = useCallback(
    async (path: string) => {
      // 请求序号：**连点两个目录时，先发的请求可能后返回**——
      // 不守卫的话，旧目录的列表会盖掉新目录的，
      // 于是又出现「路径变了、列表还是上一个」（这轮要消灭的那个 bug）。
      const seq = ++loadSeq.current;
      setBusy(true);
      setError(null);
      try {
        const entries = await listRemote(connectionId, path);
        if (seq !== loadSeq.current) return; // 有更新的请求了，这次的结果丢掉
        setRemote(entries);
      } catch (err) {
        if (seq !== loadSeq.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setRemote([]);
      } finally {
        if (seq === loadSeq.current) setBusy(false);
      }
    },
    [connectionId, listRemote],
  );

  const refresh = useCallback(() => {
    void load(currentPath);
  }, [load, currentPath]);

  /** Enter a directory */
  const enter = useCallback(
    (entry: RemoteEntry) => {
      if (!entry.isDirectory) return;
      setSelectedRemote(null);
      setCurrentPath(entry.path);
      void load(entry.path);
    },
    [load],
  );

  /** Go to the parent */
  const goUp = useCallback(() => {
    setSelectedRemote(null);
    const parent = parentPath(currentPath);
    setCurrentPath(parent);
    void load(parent);
  }, [load, currentPath]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedLocal(file);
  };

  const handleDrop = (e: React.DragEvent<HTMLLabelElement>): void => {
    // 不 preventDefault 的话，Electron 会把文件当成导航，
    // **整个窗口被替换掉那个文件**——应用看起来「崩了」。
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    setSelectedLocal(file);
  };

  if (!capabilities.files) {
    return (
      <section className="cockpit-files">
        <p className="cockpit-files__disabled" data-testid="file-push-disabled">
          {t(strings.noFileChannel)}
        </p>
      </section>
    );
  }

  const push = (): void => {
    if (!selectedLocal) return;
    // 上传的远端目标 = **当前所在的目录**
    onPush(selectedLocal, currentPath);
  };

  const pull = (): void => {
    // 目录不能下载 —— 点了也不该有反应
    if (!selectedRemote || selectedRemote.isDirectory) return;
    onPull(connectionId, selectedRemote.path);
  };

  return (
    <section className="cockpit-files" data-connection={connectionId}>
      <div className="cockpit-files__trees">
        {/* ── 左：本地 ── */}
        <div className="cockpit-tree" data-testid="tree-local">
          <div className="cockpit-tree__head">{t(strings.local)}</div>
          <label
            className="cockpit-files__label"
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            data-testid="file-drop"
          >
            {t(strings.chooseFile)}
            <input
              ref={inputRef}
              type="file"
              data-testid="file-input"
              onChange={handleChange}
            />
          </label>
          {selectedLocal ? (
            <p className="cockpit-tree__selected">{selectedLocal.name}</p>
          ) : (
            <p className="cockpit-tree__hint">{t(strings.noneSelected)}</p>
          )}
        </div>

        {/* ── 中：箭头 ── */}
        <div className="cockpit-files__arrows">
          <button
            type="button"
            data-testid="push-button"
            onClick={push}
            disabled={!selectedLocal}
            title={t(strings.upload)}
          >
            ↑
          </button>
          <button
            type="button"
            data-testid="pull-button"
            onClick={pull}
            disabled={!selectedRemote}
            title={t(strings.download)}
          >
            ↓
          </button>
        </div>

        {/* ── 右：远端 ── */}
        <div className="cockpit-tree" data-testid="tree-remote">
          <div className="cockpit-tree__head">
            <span className="cockpit-tree__path" data-testid="remote-path">
              {currentPath}
            </span>
            <span className="cockpit-tree__actions">
              <button
                type="button"
                data-testid="remote-up"
                onClick={goUp}
                disabled={busy}
                title={t(strings.up)}
              >
                ↑
              </button>
              <button
                type="button"
                data-testid="remote-refresh"
                onClick={() => void refresh()}
                disabled={busy}
              >
                {t(strings.refresh)}
              </button>
            </span>
          </div>
          <ul className="cockpit-tree__list">
            {remote.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  data-testid={entry.isDirectory ? 'remote-dir' : 'remote-file'}
                  className={
                    selectedRemote?.path === entry.path ? 'is-selected' : undefined
                  }
                  // 点目录是**进去**，点文件是**选中**
                  onClick={() => (entry.isDirectory ? enter(entry) : setSelectedRemote(entry))}
                >
                  {/* 图标用 CSS class，不混在文字里——混在一起文本就匹配不到了 */}
                  <span className={entry.isDirectory ? 'is-dir' : 'is-file'} aria-hidden />
                  {entry.name}
                </button>
              </li>
            ))}
          </ul>
          {remote.length === 0 && !busy ? (
            <p className="cockpit-tree__hint">{t(strings.refreshHint)}</p>
          ) : null}
        </div>
      </div>

      {error ? (
        <p className="cockpit-files__error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

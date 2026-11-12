import { useCallback, useRef, useState } from 'react';
import type { Capabilities } from '../../shared/ipc-contract';

/**
 * 双树文件浏览器。
 *
 * 交互沿用旧工程（`docs/03-迁移对照表.md`：「**交互设计保留，实现重写**：
 * 双树 + 懒加载 + 目标选择器 + 箭头传输」）：
 *
 * ```
 *   本地                        远端
 *  ┌──────────┐  ↑上传   ↓下载 ┌──────────┐
 *  │  文件树   │               │  文件树   │
 *  └──────────┘               └──────────┘
 * ```
 *
 * **远端树懒加载**：目录是要问宿主的，不该在渲染时就发生。
 * 点「刷新远端」才去列。
 *
 * **串口没有文件通道**（事实 S7）：`capabilities.files === false` 时
 * 两个箭头都不给，只留一句说明——不给入口，用户才知道是这条线不支持，
 * 而不是以为功能坏了。
 */

/** 远端目录里的一个条目（与 `shared/ipc-contract` 的 FileEntry 同形） */
export interface RemoteEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  sizeBytes: number | null;
  modifiedAt: string | null;
}

export interface FileBrowserProps {
  connectionId: string;
  capabilities: Capabilities;
  /** 上传：本地文件 → 远端目录 */
  onPush: (file: File, remotePath: string) => void;
  /** 下载：远端 → 本地 */
  onPull: (connectionId: string, remotePath: string) => void;
  /** 列远端目录。问宿主，由宿主去跑传输 */
  listRemote: (connectionId: string, remotePath: string) => Promise<RemoteEntry[]>;
  /** 远端当前目录，缺省是根 */
  remotePath?: string;
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
  const inputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setRemote(await listRemote(connectionId, remotePath));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRemote([]);
    } finally {
      setBusy(false);
    }
  }, [connectionId, remotePath, listRemote]);

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
          这个连接不能传文件（串口没有文件通道）
        </p>
      </section>
    );
  }

  const push = (): void => {
    if (!selectedLocal) return;
    onPush(selectedLocal, remotePath);
  };

  const pull = (): void => {
    if (!selectedRemote) return;
    onPull(connectionId, selectedRemote.path);
  };

  return (
    <section className="cockpit-files" data-connection={connectionId}>
      <div className="cockpit-files__trees">
        {/* ── 左：本地 ── */}
        <div className="cockpit-tree" data-testid="tree-local">
          <div className="cockpit-tree__head">本地</div>
          <label
            className="cockpit-files__label"
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            data-testid="file-drop"
          >
            选文件（可拖进来）
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
            <p className="cockpit-tree__hint">未选择</p>
          )}
        </div>

        {/* ── 中：箭头 ── */}
        <div className="cockpit-files__arrows">
          <button
            type="button"
            data-testid="push-button"
            onClick={push}
            disabled={!selectedLocal}
            title="上传到远端"
          >
            ↑
          </button>
          <button
            type="button"
            data-testid="pull-button"
            onClick={pull}
            disabled={!selectedRemote}
            title="从远端下载"
          >
            ↓
          </button>
        </div>

        {/* ── 右：远端 ── */}
        <div className="cockpit-tree" data-testid="tree-remote">
          <div className="cockpit-tree__head">
            远端
            <button
              type="button"
              data-testid="remote-refresh"
              onClick={() => void refresh()}
              disabled={busy}
            >
              刷新
            </button>
          </div>
          <ul className="cockpit-tree__list">
            {remote.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  className={
                    selectedRemote?.path === entry.path ? 'is-selected' : undefined
                  }
                  onClick={() => setSelectedRemote(entry)}
                >
                  {/* 图标用 CSS class，不混在文字里——混在一起文本就匹配不到了 */}
                  <span className={entry.isDirectory ? 'is-dir' : 'is-file'} aria-hidden />
                  {entry.name}
                </button>
              </li>
            ))}
          </ul>
          {remote.length === 0 && !busy ? (
            <p className="cockpit-tree__hint">点「刷新」看远端目录</p>
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

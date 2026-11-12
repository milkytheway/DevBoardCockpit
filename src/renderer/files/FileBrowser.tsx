import { useRef, useState } from 'react';
import type { Capabilities } from '../../shared/ipc-contract';

/**
 * 文件浏览器。
 *
 * **连接不支持文件传输时，入口是禁用的**（串口传文件没有意义，事实 S7）。
 * 这里给一句人话说明，而不是把按钮藏起来——用户会以为功能坏了。
 */

export interface FileBrowserProps {
  connectionId: string;
  capabilities: Capabilities;
  /** 用户选了本地文件要上传 */
  onPush: (file: File) => void;
}

export function FileBrowser({ connectionId, capabilities, onPush }: FileBrowserProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  if (!capabilities.files) {
    return (
      <section className="cockpit-files">
        <p className="cockpit-files__disabled" data-testid="file-push-disabled">
          这个连接不能传文件（串口没有文件通道）
        </p>
      </section>
    );
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPending(file.name);
    onPush(file);
  };

  const handleDrop = (e: React.DragEvent<HTMLLabelElement>): void => {
    // 不 preventDefault 的话，Electron 会把文件当成导航，
    // **整个窗口被替换成那个文件**——应用看起来「崩了」。
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    setPending(file.name);
    onPush(file);
  };

  return (
    <section className="cockpit-files" data-connection={connectionId}>
      <label
        className="cockpit-files__label"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        data-testid="file-drop"
      >
        上传到远端（可拖进来）
        <input
          ref={inputRef}
          type="file"
          data-testid="file-input"
          onChange={handleChange}
        />
      </label>
      {pending ? <p className="cockpit-files__pending">正在上传 {pending}</p> : null}
    </section>
  );
}

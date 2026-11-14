import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

/**
 * Failures have to be **visible**.
 *
 * A failure that only lives in the console is a failure the user never
 * sees: "I clicked and nothing happened". These are the judgments behind
 * that: the error bar says what went wrong, and a transfer failure is not
 * silent.
 *
 * **And the shape has to be the real one.** The host throws plain objects
 * (`makeError`), not `Error`s — after crossing IPC a real `Error` would
 * arrive as `[object Object]` while the test's hand-made `Error` would
 * still look fine. (`docs/11-计划1评审报告.md` R-03)
 */
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    onData() { return { dispose() { /* no-op */ } }; }
    onResize() { return { dispose() { /* no-op */ } }; }
    loadAddon() { /* no-op */ }
    open() { /* no-op */ }
    write() { /* no-op */ }
    focus() { /* no-op */ }
    dispose() { /* no-op */ }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() { /* no-op */ }
    proposeDimensions() { return { cols: 80, rows: 24 }; }
  },
}));

import { ErrorBar } from '../../src/renderer/shell/ErrorBar';
import { FilesPage } from '../../src/renderer/shell/pages/FilesPage';
import { makeError } from '../../src/shared/errors';

/** The capabilities of a connection that can carry files. */
const CAPS = { exec: true, pty: false, files: true, exitCode: true };

/** Install a fake host API. */
function installHost(overrides: Record<string, unknown> = {}): void {
  (window as unknown as { cockpit: unknown }).cockpit = {
    filesList: async () => [],
    filesPush: async () => ({ remotePath: '/root/a.txt' }),
    filesPull: async () => ({ localPath: 'C:\\Users\\me\\Downloads\\a.txt' }),
    getPathForFile: (file: File) => `C:\\Users\\me\\${file.name}`,
    ...overrides,
  };
}

describe('错误条', () => {
  it('把失败的原因显示出来（**真实形状**）', () => {
    const failure = makeError('PORT_BUSY', '串口 COM3 被占用');
    render(<ErrorBar message={failure.message} onDismiss={() => undefined} />);
    expect(screen.getByRole('alert').textContent).toContain('COM3');
  });

  it('没有错误时不占地方', () => {
    const { container } = render(<ErrorBar message={null} onDismiss={() => undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('「知道了」把它关掉', () => {
    let dismissed = 0;
    render(<ErrorBar message="坏了" onDismiss={() => { dismissed += 1; }} />);
    fireEvent.click(screen.getByText('知道了'));
    expect(dismissed).toBe(1);
  });
});

describe('文件页', () => {
  it('**上传用的是宿主的绝对路径**，不是文件名', async () => {
    const filesPush = vi.fn(
      async (_connectionId: string, _localPath: string, _remotePath: string) => ({
        remotePath: '/root/a.txt',
      }),
    );
    installHost({ filesPush });

    render(
      <FilesPage
        sessionId="s1"
        capabilities={CAPS}
        onPush={(file, remotePath) => {
          const localPath = window.cockpit.getPathForFile(file);
          void filesPush('s1', localPath, remotePath);
        }}
        onPull={() => undefined}
      />,
    );

    const input = await screen.findByTestId('file-input');
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.txt')] } });
    fireEvent.click(screen.getByTestId('push-button'));

    await waitFor(() => expect(filesPush).toHaveBeenCalled());
    // **不能**只传文件名——那会让宿主在自己的 CWD 里找同名文件，
    // 甚至静默传走另一个文件（数据安全问题）
    expect(filesPush.mock.calls[0][1]).toBe('C:\\Users\\me\\a.txt');
  });

  it('没有会话时明说「需要先开一个会话」（而不是空白页）', () => {
    render(
      <FilesPage
        sessionId={null}
        capabilities={null}
        onPush={() => undefined}
        onPull={() => undefined}
      />,
    );
    expect(screen.getByText(/会话/).textContent).toContain('会话');
  });
});

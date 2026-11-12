import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

/**
 * 打开连接失败时，用户要看得见原因。
 *
 * 整支评���的 C6：renderer 没有错误呈现，
 * 「串口被占用」这种错误藏在控制台里等于没报——
 * 用户只看到「点了没反应」。
 *
 * **而且这里抛的必须是「真实的形状」。**
 * 早先这个测试抛的是 `new Error(...)`（真 Error），
 * 而真实代码路径抛的是**普通对象**——
 * 于是跨 IPC 之后变成 `[object Object]`，测试照样绿。
 * （`docs/11-计划1评审报告.md` R-03）
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

import { App } from '../../src/renderer/App';
import { makeError } from '../../src/shared/errors';

/** 装一个假的宿主 API */
function installHost(overrides: Record<string, unknown> = {}): void {
  (window as unknown as { cockpit: unknown }).cockpit = {
    connectionsList: async () => [
      {
        id: 'board-serial',
        label: '板子 · 串口',
        transport: 'serial',
        boardPack: 'rk3588-atk',
        capabilities: { exec: true, pty: true, files: false, exitCode: false },
      },
      {
        id: 'board-adb',
        label: '板子 · ADB',
        transport: 'adb',
        boardPack: 'rk3588-atk',
        capabilities: { exec: true, pty: false, files: true, exitCode: true },
      },
    ],
    terminalOpen: async () => ({ sessionId: 's1' }),
    terminalWrite: () => undefined,
    terminalResize: () => undefined,
    terminalClose: async () => undefined,
    onTerminalData: () => () => undefined,
    onTerminalExit: () => () => undefined,
    filesList: async () => [],
    filesPush: async () => ({ remotePath: '/root/a.txt' }),
    filesPull: async () => ({ localPath: 'C:\\Users\\me\\Downloads\\a.txt' }),
    getPathForFile: (file: File) => `C:\\Users\\me\\${file.name}`,
    ...overrides,
  };
}

describe('App 的错误呈现', () => {
  it('打开连接失败时把原因显示出来', async () => {
    // 宿主说「串口 COM3 被占用」。
    // **抛的是 makeError 造的对象**——这才是真实代码路径抛的形状。
    installHost({
      terminalOpen: async () => {
        throw makeError('PORT_BUSY', '串口 COM3 被占用');
      },
    });

    render(<App />);

    const button = await screen.findByText('板子 · 串口');
    button.click();

    // 用户要看到「串口 COM3 被占用」，而不是「点了没反应」
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('COM3');
    });
  });

  it('文件互传失败时错误条出现 —— 失败不能是静默的', async () => {
    installHost({
      filesPush: async () => {
        throw makeError('FILE_TRANSFER_FAILED', '上传失败：C:\\tmp\\a.txt');
      },
    });

    render(<App />);

    const button = await screen.findByText('板子 · ADB');
    button.click();

    // 等到文件浏览器出来
    const input = await screen.findByTestId('file-input');
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.txt')] } });
    fireEvent.click(screen.getByTestId('push-button'));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('上传失败');
    });
  });

  it('上传用的是宿主的绝对路径，不是文件名', async () => {
    const filesPush = vi.fn(
      async (_connectionId: string, _localPath: string, _remotePath: string) => ({
        remotePath: '/root/a.txt',
      }),
    );
    installHost({ filesPush });

    render(<App />);

    const button = await screen.findByText('板子 · ADB');
    button.click();

    const input = await screen.findByTestId('file-input');
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.txt')] } });
    fireEvent.click(screen.getByTestId('push-button'));

    await waitFor(() => expect(filesPush).toHaveBeenCalled());
    // **不能**只传文件名——那会让宿主在自己的 CWD 里找同名文件，
    // 甚至静默传走另一个文件（数据安全问题）
    expect(filesPush.mock.calls[0][1]).toBe('C:\\Users\\me\\a.txt');
  });

  it('下载成功后告诉用户存到哪了', async () => {
    installHost({
      filesList: async () => [
        { name: 'a.txt', path: '/root/a.txt', isDirectory: false, sizeBytes: 3, modifiedAt: null },
      ],
    });

    render(<App />);

    const button = await screen.findByText('板子 · ADB');
    button.click();

    fireEvent.click(await screen.findByTestId('remote-refresh'));
    fireEvent.click(await screen.findByText('a.txt'));
    fireEvent.click(screen.getByTestId('pull-button'));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Downloads');
    });
  });
});

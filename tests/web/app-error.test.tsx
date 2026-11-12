import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * 打开连接失败时，用户要看得见原因。
 *
 * 整支评审的 C6：renderer 没有错误呈现，
 * 「串口被占用」这种错误藏在控制台里等于没报——
 * 用户只看到「点了没反应」。
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

describe('App 的错误呈现', () => {
  it('打开连接失败时把原因显示出来', async () => {
    // 宿主说「串口 COM3 被占用」
    (window as unknown as { cockpit: unknown }).cockpit = {
      connectionsList: async () => [
        {
          id: 'board-serial',
          label: '板子 · 串口',
          transport: 'serial',
          boardPack: 'rk3588-atk',
          capabilities: { exec: true, pty: true, files: false, exitCode: false },
        },
      ],
      terminalOpen: async () => {
        throw new Error('串口 COM3 被占用');
      },
      terminalWrite: () => undefined,
      terminalResize: () => undefined,
      terminalClose: () => undefined,
      onTerminalData: () => () => undefined,
      onTerminalExit: () => () => undefined,
      filesList: async () => [],
      filesPush: async () => undefined,
      filesPull: async () => undefined,
    };

    render(<App />);

    const button = await screen.findByText('板子 · 串口');
    button.click();

    // 用户要看到「串口 COM3 被占用」，而不是「点了没反应」
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('COM3');
    });
  });
});

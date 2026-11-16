import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { ConnectionInfo } from '../../src/shared/ipc-contract';
import { DevicePicker } from '../../src/renderer/shell/DevicePicker';

/**
 * **界面只列板卡**（`DevicePicker.tsx`）。
 *
 * 用户 2026-11-16 明确：「**设备要放在界面最顶端，仅支持板卡选择，
 * 当前有 fake 和 3588 的真版，不要把连接这些放进去**」。
 *
 * → 这个文件守的就是那一句：**菜单里不许出现连接** ✓。
 */
function conn(
  id: string,
  deviceKey: string,
  label: string,
  overrides: Partial<ConnectionInfo> = {},
): ConnectionInfo {
  return {
    id,
    label,
    transport: 'adb',
    boardPack: 'rk3588-atk',
    deviceKey,
    current: false,
    capabilities: { exec: true, pty: false, files: true, exitCode: true },
    ...overrides,
  };
}

const CONNECTIONS: ConnectionInfo[] = [
  conn('board-adb', 'atk-01', '板子 · ADB'),
  conn('board-serial', 'atk-01', '板子 · 串口', { transport: 'serial' }),
  conn('board-ssh', 'atk-01', '板子 · SSH', { transport: 'ssh' }),
  conn('fake-board', 'fake-board', '假板子 · 合成数据', { transport: 'ssh' }),
  conn('local', 'local', '本机', { boardPack: null, transport: 'local' }),
  conn('ubuntu-ssh', 'ubuntu-ssh', 'Ubuntu · SSH', { boardPack: null, transport: 'ssh' }),
];

function open(): HTMLElement {
  render(
    <DevicePicker connections={CONNECTIONS} onSelect={() => undefined} busy={false} />,
  );
  fireEvent.click(screen.getByRole('button', { name: /板子/ }));
  return screen.getByRole('listbox');
}

describe('设备选择器（只列板卡）', () => {
  it('**菜单里列的是板卡** ✓（**两块：真板与假板** ✓）', () => {
    const menu = open();
    expect(within(menu).getByText('atk-01')).toBeTruthy();
    expect(within(menu).getByText('fake-board')).toBeTruthy();
  });

  it('**菜单里没有连接** ✓（**「板子 · ADB」这种条目不许出现** ✓）', () => {
    const menu = open();
    expect(within(menu).queryByText('板子 · ADB')).toBeNull();
    expect(within(menu).queryByText('板子 · SSH')).toBeNull();
    expect(within(menu).queryByText('板子 · 串口')).toBeNull();
  });

  it('**本机与客机不是板卡** ✓（**没绑板型包的不列** ✓）', () => {
    const menu = open();
    expect(within(menu).queryByText('本机')).toBeNull();
    expect(within(menu).queryByText('Ubuntu · SSH')).toBeNull();
  });

  it('**点板卡 → 交出的是板的身份** ✓（**不是连接 id** ✓ —— **宿主去挑连接** ✓）', () => {
    const onSelect = vi.fn();
    render(
      <DevicePicker connections={CONNECTIONS} onSelect={onSelect} busy={false} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /板子/ }));
    fireEvent.click(screen.getByRole('option', { name: /fake-board/ }));
    expect(onSelect).toHaveBeenCalledWith('fake-board');
  });

  it('**当前那块板在按钮上** ✓（**一眼看出现在动的是哪块** ✓）', () => {
    render(
      <DevicePicker
        connections={CONNECTIONS.map((c) =>
          c.id === 'board-adb' ? { ...c, current: true } : c,
        )}
        onSelect={() => undefined}
        busy={false}
      />,
    );
    expect(screen.getByRole('button', { name: /板子/ }).textContent).toContain('atk-01');
  });

  it('**没有板就明说** ✓（**不装成有** ✓）', () => {
    render(
      <DevicePicker
        connections={[conn('local', 'local', '本机', { boardPack: null })]}
        onSelect={() => undefined}
        busy={false}
      />,
    );
    expect(screen.getByRole('button', { name: /板子/ }).textContent).toContain('没有板');
  });
});

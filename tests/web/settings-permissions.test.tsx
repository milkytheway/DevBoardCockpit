import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SettingsPage } from '../../src/renderer/shell/pages/SettingsPage';
import type { PermissionRow } from '../../src/shared/ipc-contract';

/**
 * **统一权限区**（设置页 ✓ · ADR-D47 ✓）。
 *
 * ── 测什么 ──
 *
 * | # | 判据 | 为什么 |
 * |---|---|---|
 * | 1 | **一行一个操作** ✓ | **一个地方** ✓ —— **想关就关** ✓ |
 * | 2 | **两种执行者各一个开关** ✓ | **卡片**（界面上的卡 ✓）与 **agent**（MCP 那条路 ✓）**不是一回事** ✓ |
 * | 3 | **拨开关 → 交出去的是「谁 + 哪个操作 + 开还是关」** ✓ | **没写清楚就等于没有** ✓ |
 * | 4 | **默认卡片不许写板子** ✓ | **C2** ✓ —— **宿主验不了「人点了按钮」** ✗ → **默认不给** ✓ |
 */
const ROWS: PermissionRow[] = [
  { op: 'action:backlight.set', label: '设置背光亮度', kind: 'action', card: false, agent: true },
  { op: 'action:system.reboot', label: '重启板子', kind: 'action', card: false, agent: true, hint: '破坏性动作' },
  { op: 'workflow:hello-kernel.build-run', label: '编译内核模块', kind: 'workflow', card: true, agent: true },
  { op: 'host:install_card', label: 'install_card', kind: 'host', card: true, agent: true },
];

function renderPage(onPermission = vi.fn()) {
  render(
    <SettingsPage
      theme="dark"
      onTheme={() => undefined}
      density="comfortable"
      onDensity={() => undefined}
      cardsCount={8}
      connectionsCount={5}
      onRefreshCards={() => undefined}
      permissions={ROWS}
      onPermission={onPermission}
    />,
  );
  return onPermission;
}

describe('设置页 · 权限区', () => {
  it('**一行一个操作** ✓', () => {
    const { container } = render(
      <SettingsPage
        theme="dark"
        onTheme={() => undefined}
        density="comfortable"
        onDensity={() => undefined}
        cardsCount={8}
        connectionsCount={5}
        onRefreshCards={() => undefined}
        permissions={ROWS}
        onPermission={() => undefined}
      />,
    );
    // **只数权限区那一列** ✓（**设置页还有别的列表** ✓ —— 快捷键那三条 ✓）
    expect(container.querySelectorAll('.perm-row').length).toBe(ROWS.length);
    expect(screen.getByText('设置背光亮度')).toBeTruthy();
    expect(screen.getByText('编译内核模块')).toBeTruthy();
  });

  it('**每个操作两个开关** ✓（**卡片** ✓ / **agent** ✓）', () => {
    renderPage();
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.length).toBe(ROWS.length * 2);
  });

  it('**默认卡片不许写板子** ✓（**C2** ✓）', () => {
    renderPage();
    const boxes = screen.getAllByRole('checkbox');
    // **第一行**：卡片（关 ✓）/ agent（开 ✓）
    expect((boxes[0] as HTMLInputElement).checked).toBe(false);
    expect((boxes[1] as HTMLInputElement).checked).toBe(true);
    // **流程那一行**：卡片（开 ✓）—— **「编译上板」那张卡要能用** ✓
    const flowIndex = ROWS.findIndex((r) => r.kind === 'workflow');
    expect((boxes[flowIndex * 2] as HTMLInputElement).checked).toBe(true);
  });

  it('**拨开关 → 交出去的是「谁 + 哪个操作 + 开还是关」** ✓', () => {
    const onPermission = renderPage();
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[0] as HTMLInputElement);
    expect(onPermission).toHaveBeenCalledWith('card', 'action:backlight.set', true);
  });

  it('**agent 的开关也是同一个口子** ✓', () => {
    const onPermission = renderPage();
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[1] as HTMLInputElement);
    expect(onPermission).toHaveBeenCalledWith('agent', 'action:backlight.set', false);
  });

  it('**破坏性动作标出来** ✓（**人得看得见** ✓）', () => {
    renderPage();
    expect(screen.getByText('破坏性动作')).toBeTruthy();
  });
});

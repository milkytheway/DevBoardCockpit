import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SettingsPage } from '../../src/renderer/shell/pages/SettingsPage';
import { LocaleContext } from '../../src/renderer/shell/i18n';
import type { PermissionRow } from '../../src/shared/ipc-contract';

/**
 * **统一权限区**（设置页 ✓ · ADR-D47 ✓）。
 *
 * ── 测什么 ──
 *
 * | # | 判据 | 为什么 |
 * |---|---|---|
 * | 1 | **一行一个操作，按类分组** ✓ | 元操作 / 流程 / 宿主 分开看 ✓ |
 * | 2 | **两种执行者各一个开关** ✓ | 卡片与 agent 不是一回事 ✓ |
 * | 3 | **拨开关 → 交出去的是「谁 + 哪个操作 + 开还是关」** ✓ | 没写清楚就等于没有 ✓ |
 * | 4 | **开关是 switch，不是 checkbox** ✓ | 视觉与语义都按 Ant Design 的开关走 ✓ |
 * | 5 | **默认卡片不许写板子** ✓ | C2：宿主验不了「人点了按钮」→ 默认不给 ✓ |
 */
const ROWS: PermissionRow[] = [
  {
    op: 'action:backlight.set',
    label: '设置背光亮度',
    kind: 'action',
    card: false,
    agent: true,
    danger: 'reversible',
  },
  {
    op: 'action:led.set',
    label: '点亮 LED',
    kind: 'action',
    card: true,
    agent: true,
    danger: 'reversible',
  },
  {
    op: 'action:system.reboot',
    label: '重启板子',
    kind: 'action',
    card: false,
    agent: true,
    danger: 'destructive',
    hint: '破坏性动作',
  },
  { op: 'workflow:hello-kernel.build-run', label: '编译内核模块', kind: 'workflow', card: true, agent: true },
  { op: 'host:install_card', label: 'install_card', kind: 'host', card: true, agent: true },
];

/**
 * **中文分支** ✓ —— 页面文案有中英两个分支，这里把语言钉在中文上，
 * 断言里的期望值就是**中文分支的文案** ✓。
 */
function renderPage(onPermission = vi.fn(), onLocale = vi.fn()) {
  const view = render(
    <LocaleContext.Provider value="zh-Hans">
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
        locale="zh-Hans"
        onLocale={onLocale}
      />
    </LocaleContext.Provider>,
  );
  return { onPermission, onLocale, container: view.container };
}

describe('设置页 · 权限区', () => {
  it('**一行一个操作** ✓', () => {
    const { container } = renderPage();
    expect(container.querySelectorAll('.perm-row').length).toBe(ROWS.length);
    expect(screen.getByText('设置背光亮度')).toBeTruthy();
    expect(screen.getByText('编译内核模块')).toBeTruthy();
  });

  it('**按类分组** ✓（元操作 / 流程 / 宿主 ✓）', () => {
    const { container } = renderPage();
    const heads = [...container.querySelectorAll('.perm-group__head h3')].map(
      (node) => node.textContent,
    );
    expect(heads).toEqual(['元操作', '流程', '宿主']);
  });

  it('**每个操作两个 switch** ✓（**卡片** ✓ / **agent** ✓）', () => {
    const { container } = renderPage();
    for (const row of container.querySelectorAll('.perm-row')) {
      expect(row.querySelectorAll('[role="switch"]').length).toBe(2);
    }
    expect(container.querySelectorAll('[role="checkbox"]').length).toBe(0);
  });

  it('**默认卡片不许写板子** ✓（**C2** ✓）', () => {
    renderPage();
    expect(
      screen.getByRole('switch', { name: '设置背光亮度 · 卡片授权' }).getAttribute('aria-checked'),
    ).toBe('false');
    expect(
      screen.getByRole('switch', { name: '设置背光亮度 · agent 授权' }).getAttribute('aria-checked'),
    ).toBe('true');
    // **流程那一行**：卡片（开 ✓）——「编译上板」那张卡要能用 ✓
    expect(
      screen.getByRole('switch', { name: '编译内核模块 · 卡片授权' }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('**拨开关 → 交出去的是「谁 + 哪个操作 + 开还是关」** ✓', () => {
    const { onPermission } = renderPage();
    fireEvent.click(screen.getByRole('switch', { name: '设置背光亮度 · 卡片授权' }));
    expect(onPermission).toHaveBeenCalledWith('card', 'action:backlight.set', true);
  });

  it('**agent 的开关也是同一个口子** ✓', () => {
    const { onPermission } = renderPage();
    fireEvent.click(screen.getByRole('switch', { name: '设置背光亮度 · agent 授权' }));
    expect(onPermission).toHaveBeenCalledWith('agent', 'action:backlight.set', false);
  });

  it('**破坏性动作标出来** ✓（**人得看得见** ✓）', () => {
    const { container } = renderPage();
    expect(screen.getByText('破坏性动作')).toBeTruthy();
    expect(container.querySelectorAll('.perm-row__danger').length).toBe(1);
  });

  it('**总开关只放非破坏性动作** ✓（危险动作逐条打开 ✓）', () => {
    const { onPermission } = renderPage();
    // 两条可批量（背光、LED），一条危险（重启）不跟着走
    expect(screen.getByText('1 / 2 条对卡片开放')).toBeTruthy();
    const master = screen.getByRole('switch', { name: '为卡片打开元操作授权' });
    expect(master.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(master);
    expect(onPermission).toHaveBeenCalledWith('card', 'action:backlight.set', true);
    expect(onPermission).toHaveBeenCalledWith('card', 'action:led.set', true);
    expect(onPermission).not.toHaveBeenCalledWith('card', 'action:system.reboot', true);
  });
});

describe('设置页 · 语言选择', () => {
  it('**列出两种语言，并报告选择** ✓', () => {
    const onLocale = vi.fn();
    const { container } = renderPage(vi.fn(), onLocale);

    const group = container.querySelector('.segmented[aria-label="语言"]');
    expect(group, '设置页要有语言选择器 ✓').toBeTruthy();
    expect(group?.querySelectorAll('button').length).toBe(2);

    const english = screen.getByRole('button', { name: 'English' });
    fireEvent.click(english);
    expect(onLocale).toHaveBeenCalledWith('en');
  });
});

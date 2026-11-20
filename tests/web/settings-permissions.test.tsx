import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SettingsPage } from '../../src/renderer/shell/pages/SettingsPage';
import { LocaleContext } from '../../src/renderer/shell/i18n';
import type { PermissionRow } from '../../src/shared/ipc-contract';

/**
 * The unified permission area (the settings page; ADR-D47).
 *
 * ── What is under test ──
 *
 * | # | Judgment | Why |
 * |---|---|---|
 * | 1 | One operation per row, grouped by kind | meta operations, workflows and host capabilities are read apart |
 * | 2 | One switch per executor | a card and an agent are not the same thing |
 * | 3 | A switch hands over "who, which operation, on or off" | an unclear handover is no handover at all |
 * | 4 | The control is a switch, not a checkbox | the visuals and the semantics follow the Ant Design switch |
 * | 5 | A card may not write to the board by default | C2: the host cannot verify that a person pressed the button, so the default is no |
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
 * The Chinese branch: the page has two wordings, the locale is pinned here,
 * and the expected values in the assertions are the wording of the Chinese
 * branch.
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

describe('The settings page · the permission area', () => {
  it('one operation per row', () => {
    const { container } = renderPage();
    expect(container.querySelectorAll('.perm-row').length).toBe(ROWS.length);
    expect(screen.getByText('设置背光亮度')).toBeTruthy();
    expect(screen.getByText('编译内核模块')).toBeTruthy();
  });

  it('grouped by kind (meta operations, workflows, host)', () => {
    const { container } = renderPage();
    const heads = [...container.querySelectorAll('.perm-group__head h3')].map(
      (node) => node.textContent,
    );
    expect(heads).toEqual(['元操作', '流程', '宿主']);
  });

  it('two switches per operation (card and agent)', () => {
    const { container } = renderPage();
    for (const row of container.querySelectorAll('.perm-row')) {
      expect(row.querySelectorAll('[role="switch"]').length).toBe(2);
    }
    expect(container.querySelectorAll('[role="checkbox"]').length).toBe(0);
  });

  it('by default a card may not write to the board (C2)', () => {
    renderPage();
    expect(
      screen.getByRole('switch', { name: '设置背光亮度 · 卡片授权' }).getAttribute('aria-checked'),
    ).toBe('false');
    expect(
      screen.getByRole('switch', { name: '设置背光亮度 · agent 授权' }).getAttribute('aria-checked'),
    ).toBe('true');
    // The workflow row: the card is on — the build-and-deploy card needs it
    expect(
      screen.getByRole('switch', { name: '编译内核模块 · 卡片授权' }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('a switch hands over "who, which operation, on or off"', () => {
    const { onPermission } = renderPage();
    fireEvent.click(screen.getByRole('switch', { name: '设置背光亮度 · 卡片授权' }));
    expect(onPermission).toHaveBeenCalledWith('card', 'action:backlight.set', true);
  });

  it('the agent switch goes through the same door', () => {
    const { onPermission } = renderPage();
    fireEvent.click(screen.getByRole('switch', { name: '设置背光亮度 · agent 授权' }));
    expect(onPermission).toHaveBeenCalledWith('agent', 'action:backlight.set', false);
  });

  it('a destructive action is marked (the person has to see it)', () => {
    const { container } = renderPage();
    expect(screen.getByText('破坏性动作')).toBeTruthy();
    expect(container.querySelectorAll('.perm-row__danger').length).toBe(1);
  });

  it('the master switch only covers the non-destructive actions (a destructive one is enabled one by one)', () => {
    const { onPermission } = renderPage();
    // Two of them can be toggled in bulk (backlight, LED); the destructive one
    // (reboot) does not follow.
    expect(screen.getByText('1 / 2 条对卡片开放')).toBeTruthy();
    const master = screen.getByRole('switch', { name: '为卡片打开元操作授权' });
    expect(master.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(master);
    expect(onPermission).toHaveBeenCalledWith('card', 'action:backlight.set', true);
    expect(onPermission).toHaveBeenCalledWith('card', 'action:led.set', true);
    expect(onPermission).not.toHaveBeenCalledWith('card', 'action:system.reboot', true);
  });
});

describe('The settings page · the language selection', () => {
  it('offers the two languages and reports the choice', () => {
    const onLocale = vi.fn();
    const { container } = renderPage(vi.fn(), onLocale);

    const group = container.querySelector('.segmented[aria-label="语言"]');
    expect(group, 'the settings page needs a language selector').toBeTruthy();
    expect(group?.querySelectorAll('button').length).toBe(2);

    const english = screen.getByRole('button', { name: 'English' });
    fireEvent.click(english);
    expect(onLocale).toHaveBeenCalledWith('en');
  });
});

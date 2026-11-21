import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { ConnectionInfo } from '../../src/shared/ipc-contract';
import { DevicePicker } from '../../src/renderer/shell/DevicePicker';
import { LocaleContext } from '../../src/renderer/shell/i18n';

/**
 * The interface lists boards only (`DevicePicker.tsx`).
 *
 * The user was explicit on 2026-11-16: "put the device at the very top of
 * the interface, support the selection of a board only — there is a fake and
 * the real 3588 — do not put the connections in there".
 *
 * → What this file guards is exactly that sentence: the menu must not offer
 *   the connections.
 *
 * The locale is pinned to English, so the wording under test is fixed.
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
  conn('board-adb', 'atk-01', 'Board · ADB'),
  conn('board-serial', 'atk-01', 'Board · Serial', { transport: 'serial' }),
  conn('board-ssh', 'atk-01', 'Board · SSH', { transport: 'ssh' }),
  conn('fake-board', 'fake-board', 'Fake board · synthetic data', { transport: 'ssh' }),
  conn('local', 'local', 'Local', { boardPack: null, transport: 'local' }),
  conn('ubuntu-ssh', 'ubuntu-ssh', 'Ubuntu · SSH', { boardPack: null, transport: 'ssh' }),
];

function open(onAddBoard?: () => void): HTMLElement {
  render(
    <LocaleContext.Provider value="en">
      <DevicePicker
        connections={CONNECTIONS}
        onSelect={() => undefined}
        onAddBoard={onAddBoard}
        busy={false}
      />
    </LocaleContext.Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Board/ }));
  return screen.getByRole('listbox');
}

describe('The device picker (boards only)', () => {
  it('the menu lists boards (two of them: the real board and the fake one)', () => {
    const menu = open();
    expect(within(menu).getByText('atk-01')).toBeTruthy();
    expect(within(menu).getByText('fake-board')).toBeTruthy();
  });

  it('the menu holds no connection (an entry such as "Board · ADB" must not appear)', () => {
    const menu = open();
    expect(within(menu).queryByText('Board · ADB')).toBeNull();
    expect(within(menu).queryByText('Board · SSH')).toBeNull();
    expect(within(menu).queryByText('Board · Serial')).toBeNull();
  });

  it('the local machine and the guest are not boards (a connection without a board pack is not listed)', () => {
    const menu = open();
    expect(within(menu).queryByText('Local')).toBeNull();
    expect(within(menu).queryByText('Ubuntu · SSH')).toBeNull();
  });

  it('clicking a board hands over the board identity, not a connection id (the host picks the connection)', () => {
    const onSelect = vi.fn();
    render(
      <LocaleContext.Provider value="en">
        <DevicePicker connections={CONNECTIONS} onSelect={onSelect} busy={false} />
      </LocaleContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Board/ }));
    fireEvent.click(screen.getByRole('option', { name: /fake-board/ }));
    expect(onSelect).toHaveBeenCalledWith('fake-board');
  });

  it('the current board is shown on the button (it is obvious which one is in use)', () => {
    render(
      <LocaleContext.Provider value="en">
        <DevicePicker
          connections={CONNECTIONS.map((c) =>
            c.id === 'board-adb' ? { ...c, current: true } : c,
          )}
          onSelect={() => undefined}
          busy={false}
        />
      </LocaleContext.Provider>,
    );
    expect(screen.getByRole('button', { name: /Board/ }).textContent).toContain('atk-01');
  });

  it('with no board the picker says so (it does not pretend there is one)', () => {
    render(
      <LocaleContext.Provider value="en">
        <DevicePicker
          connections={[conn('local', 'local', 'Local', { boardPack: null })]}
          onSelect={() => undefined}
          busy={false}
        />
      </LocaleContext.Provider>,
    );
    expect(screen.getByRole('button', { name: /Board/ }).textContent).toContain('No board');
  });

  it('offers the board wizard from the board menu instead of the main navigation', () => {
    const onAddBoard = vi.fn();
    open(onAddBoard);

    fireEvent.click(screen.getByRole('button', { name: 'Add board' }));

    expect(onAddBoard).toHaveBeenCalledTimes(1);
  });
});

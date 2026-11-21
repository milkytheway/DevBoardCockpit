import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BoardSetup } from '../../src/renderer/shell/BoardSetup';
import { LocaleContext } from '../../src/renderer/shell/i18n';
import type { BoardDetection } from '../../src/shared/board-setup';

/**
 * **The board setup** ✓ — the values that belong to **this machine** ✓.
 *
 * | # | Criterion | Why |
 * |---|---|---|
 * | 1 | The detected values **fill the fields** ✓ | the detection is a proposal ✓ · the person decides ✓ |
 * | 2 | The port list says **which port answers** ✓ | a port that exists proves nothing ✓ |
 * | 3 | **Saving** hands the values over ✓ | the person is the authority ✓ |
 * | 4 | Every connection of this machine is listed ✓ | the guest machine's address is as much the person's as the board's ✓ |
 */

const DETECTION: BoardDetection = {
  adbDevices: [{ serial: 'f34dca7784396ab2', state: 'device', stateText: 'device' }],
  model: 'ATK-DLRK3588 Board',
  address: '192.168.5.100',
  addresses: [
    { address: '192.168.5.100', reachable: true, detail: null },
    { address: '192.168.100.2', reachable: false, detail: 'timed out' },
  ],
  ports: [
    { path: 'COM3', answered: false },
    { path: 'COM7', answered: true },
  ],
  sshKeys: ['/home/u/.ssh/id_ed25519'],
  boardPack: 'rk3588-atk',
  connections: [
    {
      id: 'board-ssh',
      label: 'Board · SSH',
      transport: 'ssh',
      boardPack: 'rk3588-atk',
      values: { host: '192.168.5.100', username: 'root' },
      sources: { host: 'detected', username: 'builtin' },
    },
    {
      id: 'ubuntu-ssh',
      label: 'Ubuntu · SSH',
      transport: 'ssh',
      boardPack: null,
      values: { host: '192.168.136.131', username: 'alientek' },
      sources: { host: 'detected', username: 'builtin' },
    },
  ],
};

function renderSetup(onApplied = vi.fn()) {
  const detect = vi.fn(async () => DETECTION);
  const apply = vi.fn(async (_values: unknown) => ({ written: ['board-ssh'], kept: [] }));
  (window as unknown as { cockpit: unknown }).cockpit = {
    boardDetect: detect,
    boardApply: apply,
  };
  const view = render(
    <LocaleContext.Provider value="zh-Hans">
      <BoardSetup onApplied={onApplied} />
    </LocaleContext.Provider>,
  );
  return { detect, apply, onApplied, view };
}

describe('the board setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('**the detection fills the fields** ✓ (the detection is a proposal ✓)', async () => {
    renderSetup();
    fireEvent.click(screen.getByText('探测'));
    await waitFor(() => expect(screen.getByDisplayValue('192.168.5.100')).toBeTruthy());
    expect((screen.getByDisplayValue('192.168.136.131') as HTMLInputElement).value).toBe(
      '192.168.136.131',
    );
  });

  it('**the port list says which port answers** ✓', async () => {
    renderSetup();
    fireEvent.click(screen.getByText('探测'));
    await waitFor(() => expect(screen.getByText('COM7')).toBeTruthy());
    expect(screen.getByText('COM3').parentElement?.textContent).toContain('没回应');
    expect(screen.getByText('COM7').parentElement?.textContent).toContain('有回应');
  });

  it('**the addresses that were tried are shown with the reason** ✓', async () => {
    renderSetup();
    fireEvent.click(screen.getByText('探测'));
    await waitFor(() => expect(screen.getByText('192.168.100.2')).toBeTruthy());
    expect(screen.getByText('192.168.100.2').parentElement?.textContent).toContain('timed out');
  });

  it('**saving hands the confirmed values over** ✓', async () => {
    const { apply, onApplied } = renderSetup();
    fireEvent.click(screen.getByText('探测'));
    await waitFor(() => expect(screen.getByDisplayValue('192.168.5.100')).toBeTruthy());
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply.mock.calls[0]?.[0] as unknown).toEqual([
      { id: 'board-ssh', fields: expect.objectContaining({ host: '192.168.5.100' }) },
      { id: 'ubuntu-ssh', fields: expect.objectContaining({ host: '192.168.136.131' }) },
    ]);
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
  });

  it('**the person may correct a value before saving** ✓', async () => {
    const { apply } = renderSetup();
    fireEvent.click(screen.getByText('探测'));
    await waitFor(() => expect(screen.getByDisplayValue('192.168.5.100')).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue('192.168.5.100'), {
      target: { value: '10.0.0.9' },
    });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    const payload = apply.mock.calls[0]?.[0] as unknown as {
      id: string;
      fields: Record<string, string>;
    }[];
    expect(payload.find((entry) => entry.id === 'board-ssh')?.fields['host']).toBe('10.0.0.9');
  });

  it('**every connection of this machine is listed** ✓ (the guest machine too ✓)', async () => {
    renderSetup();
    fireEvent.click(screen.getByText('探测'));
    await waitFor(() => expect(screen.getByText(/Board · SSH/)).toBeTruthy());
    expect(screen.getByText(/Ubuntu · SSH/)).toBeTruthy();
  });
});

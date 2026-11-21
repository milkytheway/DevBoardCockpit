import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BoardSetup } from '../../src/renderer/shell/BoardSetup';
import { LocaleContext } from '../../src/renderer/shell/i18n';
import type { CockpitApi } from '../../src/shared/ipc-contract';

/**
 * **The board setup** — the values that belong to **this machine** ✓.
 *
 * | # | Judgment | Why |
 * |---|---|---|
 * | 1 | The detection only **looks** | the person decides what is written ✓ |
 * | 2 | The detected values **fill the fields** | the detection is a proposal ✓ — the person may change it ✓ |
 * | 3 | The port list says **which port answers** | a COM port that exists proves nothing ✓ — a port that answers is the console ✓ |
 * | 4 | **Saving** hands the confirmed values over | the values are the person's ✓ |
 * | 5 | **No board pack → the save is disabled** | without a pack the values belong to nothing ✓ |
 */

const DETECTION = {
  adbDevices: [{ serial: 'f34dca7784396ab2', state: 'device', stateText: 'device' }],
  model: 'ATK-DLRK3588 Board',
  address: '192.168.100.10',
  ports: [
    { path: 'COM3', answered: false },
    { path: 'COM7', answered: true },
  ],
  boardPack: 'rk3588-atk',
};

function apiMock(overrides: Partial<CockpitApi> = {}): {
  detect: ReturnType<typeof vi.fn>;
  apply: ReturnType<typeof vi.fn>;
} {
  const detect = vi.fn(async () => DETECTION);
  const apply = vi.fn(async () => ({ written: ['board-adb'], kept: [] }));
  (window as unknown as { cockpit: unknown }).cockpit = {
    boardDetect: detect,
    boardApply: apply,
    ...overrides,
  } as unknown as CockpitApi;
  return { detect, apply };
}

function renderSetup(onApplied = vi.fn()) {
  return render(
    <LocaleContext.Provider value="zh-Hans">
      <BoardSetup onApplied={onApplied} />
    </LocaleContext.Provider>,
  );
}

describe('the board setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('**the detection fills the fields** ✓ (the detection is a proposal ✓)', async () => {
    apiMock();
    renderSetup();
    fireEvent.click(screen.getByText('探测'));
    await waitFor(() => expect(screen.getByDisplayValue('f34dca7784396ab2')).toBeTruthy());
    expect((screen.getByDisplayValue('192.168.100.10') as HTMLInputElement).value).toBe(
      '192.168.100.10',
    );
    // → **The port that answers is offered** ✓
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('COM7');
  });

  it('**the port list says which port answers** ✓', async () => {
    apiMock();
    renderSetup();
    fireEvent.click(screen.getByText('探测'));
    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());
    const options = screen.getAllByRole('option') as HTMLOptionElement[];
    const com3 = options.find((option) => option.value === 'COM3');
    const com7 = options.find((option) => option.value === 'COM7');
    expect(com3?.textContent).toContain('没回应');
    expect(com7?.textContent).toContain('有回应');
  });

  it('**saving hands the confirmed values over** ✓', async () => {
    const { apply } = apiMock();
    const onApplied = vi.fn();
    renderSetup(onApplied);
    fireEvent.click(screen.getByText('探测'));
    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply.mock.calls[0]?.[0]).toMatchObject({
      boardPack: 'rk3588-atk',
      adbSerial: 'f34dca7784396ab2',
      address: '192.168.100.10',
      serialPort: 'COM7',
    });
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
  });

  it('**without a board pack the save is disabled** ✓ (the values would belong to nothing ✓)', async () => {
    apiMock({
      boardDetect: vi.fn(async () => ({ ...DETECTION, boardPack: null })),
    } as unknown as Partial<CockpitApi>);
    renderSetup();
    fireEvent.click(screen.getByText('探测'));
    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());
    const save = screen.getByText('保存') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('**a failing detection says so** ✓ (it does not fail silently ✓)', async () => {
    apiMock({
      boardDetect: vi.fn(async () => {
        throw new Error('adb is not installed');
      }),
    } as unknown as Partial<CockpitApi>);
    renderSetup();
    fireEvent.click(screen.getByText('探测'));
    await waitFor(() => expect(screen.getByText(/adb is not installed/)).toBeTruthy());
  });
});

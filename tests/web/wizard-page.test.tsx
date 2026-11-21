import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WizardPage } from '../../src/renderer/shell/pages/WizardPage';
import { LocaleContext } from '../../src/renderer/shell/i18n';
import type { WizardRequest } from '../../src/renderer/shell/pages/WizardPage';
import type { WizardRunResult } from '../../src/shared/ipc-contract';
import type { BoardDetection } from '../../src/shared/board-setup';

const BASE: WizardRunResult = {
  ok: true,
  kind: 'ok',
  message: 'done — this board now has a pack of its own',
  hints: [],
  greenCount: 12,
  redCount: 1,
  installedDir: 'C:\\Users\\<user>\\AppData\\Roaming\\devboard\\boards\\ATK-DLRK3588',
  boardId: 'ATK-DLRK3588',
};

const DETECTION: BoardDetection = {
  adbDevices: [{ serial: 'a1b2c3d4e5f60718', state: 'device', stateText: 'device' }],
  model: 'ATK-DLRK3588 Board',
  address: '192.168.5.100',
  ports: [
    { path: 'COM3', answered: false },
    { path: 'COM7', answered: true },
  ],
  boardPack: 'rk3588-atk',
  sshKeys: [],
};

function renderZh(ui: JSX.Element): ReturnType<typeof render> {
  return render(<LocaleContext.Provider value="zh-Hans">{ui}</LocaleContext.Provider>);
}

function pendingRun(): (input: WizardRequest) => Promise<WizardRunResult> {
  return vi.fn((_input: WizardRequest) => new Promise<WizardRunResult>(() => undefined));
}

async function renderWizard(
  run: (input: WizardRequest) => Promise<WizardRunResult>,
  onInstalled = vi.fn(),
): Promise<ReturnType<typeof render>> {
  const view = renderZh(
    <WizardPage run={run} detect={async () => DETECTION} onInstalled={onInstalled} />,
  );
  await waitFor(() => {
    expect(
      (screen.getByRole('combobox', { name: '串口' }) as HTMLSelectElement).value,
    ).toBe('COM7');
  });
  return view;
}

describe('the board setup wizard', () => {
  it('offers detected COM ports and common baud rates, and does not ask for a board name', async () => {
    await renderWizard(pendingRun());
    const port = screen.getByRole('combobox', { name: '串口' }) as HTMLSelectElement;
    const baud = screen.getByRole('combobox', { name: '波特率' }) as HTMLSelectElement;

    expect([...port.options].map((option) => option.value).filter(Boolean)).toEqual([
      'COM3',
      'COM7',
    ]);
    expect(port.value).toBe('COM7');
    expect([...baud.options].map((option) => option.value)).toContain('1500000');
    expect([...baud.options].map((option) => option.value)).toContain('115200');
    expect(screen.queryByLabelText('板子名字')).toBeNull();
  });

  it('ADB disables the serial choices and submits no port, baud rate or board name', async () => {
    const run = pendingRun();
    await renderWizard(run);

    fireEvent.click(screen.getByRole('button', { name: 'ADB' }));
    expect(
      (screen.getByRole('combobox', { name: '串口' }) as HTMLSelectElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('combobox', { name: '波特率' }) as HTMLSelectElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '建立连接' }));

    expect(run).toHaveBeenCalledWith({
      transport: 'adb',
      port: '',
      baudrate: 0,
    });
  });

  it('submits the selected serial port, and the waiting text says "establish the connection"', async () => {
    const run = pendingRun();
    const { container } = await renderWizard(run);
    fireEvent.change(screen.getByRole('combobox', { name: '串口' }), {
      target: { value: 'COM3' },
    });
    fireEvent.click(screen.getByRole('button', { name: '建立连接' }));

    expect(run).toHaveBeenCalledWith({
      transport: 'serial',
      port: 'COM3',
      baudrate: 1500000,
    });
    expect(container.querySelector('.wizard-wait__title')?.textContent).toBe('建立连接');
  });

  it('the wait advances to capability detection without inventing a percentage', async () => {
    const run = pendingRun();
    const { container } = await renderWizard(run);
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole('button', { name: '建立连接' }));
      act(() => {
        vi.advanceTimersByTime(6_500);
      });

      expect(container.querySelector('.wizard-wait__title')?.textContent).toBe('检测开发板能力');
      expect(screen.getByRole('status').textContent).not.toContain('%');
    } finally {
      vi.useRealTimers();
    }
  });

  it('on success it shows the detected board id, host-side counts and refreshes the shell', async () => {
    const run = vi.fn(() => Promise.resolve(BASE));
    const onInstalled = vi.fn();
    const { container } = await renderWizard(run, onInstalled);
    fireEvent.click(screen.getByRole('button', { name: '建立连接' }));

    expect(await screen.findByText('开发板已添加')).toBeTruthy();
    expect(container.querySelector('.wizard-result__title')?.textContent).toBe('开发板已添加');
    expect(screen.getByText('开发板 ID · ATK-DLRK3588')).toBeTruthy();
    expect(screen.getByText('初始配置')).toBeTruthy();
    expect(onInstalled).toHaveBeenCalledTimes(1);
  });

  it('a busy serial port is reported as "cannot open"', async () => {
    const run = vi.fn(() =>
      Promise.resolve({
        ...BASE,
        ok: false,
        kind: 'port-unopenable' as const,
        message: '**the serial port cannot be opened** —— Access denied',
        installedDir: undefined,
      }),
    );
    const { container } = await renderWizard(run);
    fireEvent.click(screen.getByRole('button', { name: '建立连接' }));

    expect(await screen.findByText(/Access denied/)).toBeTruthy();
    expect(container.querySelector('.wizard-result__title')?.textContent).toBe('无法打开串口');
  });
});

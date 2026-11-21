import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { WizardPage } from '../../src/renderer/shell/pages/WizardPage';
import { LocaleContext } from '../../src/renderer/shell/i18n';
import type { WizardRequest } from '../../src/renderer/shell/pages/WizardPage';
import type { WizardRunResult } from '../../src/shared/ipc-contract';

const BASE: WizardRunResult = {
  ok: true,
  kind: 'ok',
  message: 'done — this board now has a pack of its own',
  hints: [],
  greenCount: 12,
  redCount: 1,
  installedDir: 'C:\\Users\\<user>\\AppData\\Roaming\\devboard\\boards\\my-board',
  boardId: 'my-board',
};

/**
 * The Chinese branch: the page has two wordings, the locale is pinned here,
 * and the expected values in the assertions are the wording of the Chinese
 * branch.
 */
function renderZh(ui: JSX.Element): ReturnType<typeof render> {
  return render(<LocaleContext.Provider value="zh-Hans">{ui}</LocaleContext.Provider>);
}

function pendingRun(): (input: WizardRequest) => Promise<WizardRunResult> {
  return vi.fn(
    (_input: WizardRequest) => new Promise<WizardRunResult>(() => undefined),
  );
}

function fill(port = 'COM7', name = 'my board'): void {
  fireEvent.change(screen.getByLabelText('串口'), { target: { value: port } });
  fireEvent.change(screen.getByLabelText('板子名字'), { target: { value: name } });
}

describe('The board setup wizard page', () => {
  it('there are three fields; with ADB the serial port and the baud rate grey out but do not disappear', () => {
    const run = pendingRun();
    const { container } = renderZh(<WizardPage run={run} />);

    expect(container.querySelectorAll('.wizard-field input').length).toBe(3);
    expect(screen.queryByText(/扫描|自动枚举/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'ADB' }));
    expect((screen.getByLabelText('串口') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('波特率') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByLabelText('串口')).toBeTruthy();
    expect((screen.getByLabelText('板子名字') as HTMLInputElement).disabled).toBe(false);
  });

  it('the serial port submits what the person typed; while it runs the button is disabled and says what is happening', () => {
    const run = pendingRun();
    const { container } = renderZh(<WizardPage run={run} />);
    fill('COM7', 'my board');

    fireEvent.click(screen.getByRole('button', { name: '开始接板' }));

    expect(run).toHaveBeenCalledWith({
      transport: 'serial',
      port: 'COM7',
      baudrate: 1500000,
      boardName: 'my board',
    });
    const button = screen.getByRole('button', { name: '正在接板…' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('.wizard-wait__title')?.textContent).toBe('建立第一个真相');
  });

  it('the ADB submission carries neither the serial port nor the baud rate (the host ignores them, and the interface must not pretend they apply)', () => {
    const run = pendingRun();
    renderZh(<WizardPage run={run} />);
    fireEvent.change(screen.getByLabelText('板子名字'), { target: { value: 'my board' } });
    fireEvent.click(screen.getByRole('button', { name: 'ADB' }));
    fireEvent.click(screen.getByRole('button', { name: '开始接板' }));

    expect(run).toHaveBeenCalledWith({
      transport: 'adb',
      port: '',
      baudrate: 0,
      boardName: 'my board',
    });
  });

  it('the wording changes as the wait advances, and it still reports no percentage', () => {
    vi.useFakeTimers();
    try {
      const run = pendingRun();
      const { container } = renderZh(<WizardPage run={run} />);
      fill();
      fireEvent.click(screen.getByRole('button', { name: '开始接板' }));

      act(() => {
        vi.advanceTimersByTime(6_500);
      });

      expect(container.querySelector('.wizard-wait__title')?.textContent).toBe('试 13 个元操作');
      expect(screen.getByRole('status').textContent).toContain('6s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('on success: the main visual, the usable count, the package path, the note about the first version, and a notice to the shell to refresh', async () => {
    const run = vi.fn(() => Promise.resolve(BASE));
    const onInstalled = vi.fn();
    const { container } = renderZh(<WizardPage run={run} onInstalled={onInstalled} />);
    fill();

    fireEvent.click(screen.getByRole('button', { name: '开始接板' }));

    expect(await screen.findByText('开发板已添加')).toBeTruthy();
    expect(container.querySelector('.wizard-result__title')?.textContent).toBe(
      '开发板已添加',
    );
    expect(container.querySelector('.wizard-result__summary')?.textContent).toContain('12');
    expect(container.querySelector('.wizard-result__summary')?.textContent).toContain('1');
    expect(screen.getByText(BASE.installedDir as string)).toBeTruthy();
    expect(screen.getByText(/这是自动探出来的初版包/)).toBeTruthy();
    expect(screen.getByText('板的 id · my-board')).toBeTruthy();
    expect(onInstalled).toHaveBeenCalledTimes(1);
  });

  it('the serial port does not open: suspect that something else holds the port', async () => {
    const run = vi.fn(() =>
      Promise.resolve({
        ...BASE,
        ok: false,
        kind: 'port-unopenable' as const,
        message: '**the serial port cannot be opened** —— Opening COM9: Access denied',
        greenCount: 0,
        redCount: 0,
        installedDir: undefined,
      }),
    );
    const { container } = renderZh(<WizardPage run={run} />);
    fill('COM9');

    fireEvent.click(screen.getByRole('button', { name: '开始接板' }));

    expect(await screen.findByText(/Access denied/)).toBeTruthy();
    expect(container.querySelector('.wizard-result__title')?.textContent).toBe('串口打不开');
    expect(screen.getByText(/有别的程序正独占着那个口/)).toBeTruthy();
  });

  it('the board says nothing: no "the connection failed", and the hints are listed one by one', async () => {
    const run = vi.fn(() =>
      Promise.resolve({
        ...BASE,
        ok: false,
        kind: 'no-reply' as const,
        message: '**the board said nothing** —— it is connected, but the command did not answer',
        greenCount: 0,
        redCount: 0,
        installedDir: undefined,
      }),
    );
    const { container } = renderZh(<WizardPage run={run} />);
    fill();

    fireEvent.click(screen.getByRole('button', { name: '开始接板' }));

    expect(await screen.findByText(/it is connected, but the command did not answer/)).toBeTruthy();
    expect(container.querySelector('.wizard-result__title')?.textContent).toBe('板子没说话');
    expect(container.textContent).not.toContain('the connection failed');
    expect(container.querySelectorAll('.wizard-hints li').length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText(/1500000/).length).toBeGreaterThan(0);
  });

  it('that connection never came through: look at the connection first, not at the meta operations', async () => {
    const run = vi.fn(() =>
      Promise.resolve({
        ...BASE,
        ok: false,
        kind: 'connection-dead' as const,
        message: '**not a single number came out** —— it is most likely not the problem of those meta-operations',
        greenCount: 0,
        redCount: 0,
        installedDir: undefined,
      }),
    );
    renderZh(<WizardPage run={run} />);
    fill();

    fireEvent.click(screen.getByRole('button', { name: '开始接板' }));

    expect(await screen.findByText('那条连接一次都没通')).toBeTruthy();
    expect(screen.getByText(/先查连接本身/)).toBeTruthy();
  });
});

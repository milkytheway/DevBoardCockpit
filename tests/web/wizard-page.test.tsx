import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { WizardPage } from '../../src/renderer/shell/pages/WizardPage';
import type { WizardRequest } from '../../src/renderer/shell/pages/WizardPage';
import type { WizardRunResult } from '../../src/shared/ipc-contract';

const BASE: WizardRunResult = {
  ok: true,
  kind: 'ok',
  message: '好了 —— 包已经落在用户目录',
  hints: [],
  greenCount: 12,
  redCount: 1,
  installedDir: 'C:\\Users\\Administrator\\AppData\\Roaming\\devboard\\boards\\my-board',
  boardId: 'my-board',
};

function pendingRun(): (input: WizardRequest) => Promise<WizardRunResult> {
  return vi.fn(
    (_input: WizardRequest) => new Promise<WizardRunResult>(() => undefined),
  );
}

function fill(port = 'COM7', name = '我的板'): void {
  fireEvent.change(screen.getByLabelText('串口'), { target: { value: port } });
  fireEvent.change(screen.getByLabelText('板子名字'), { target: { value: name } });
}

describe('接板向导页', () => {
  it('**只有三个字段**，ADB 时串口与波特率变灰但不消失', () => {
    const run = pendingRun();
    const { container } = render(<WizardPage run={run} />);

    expect(container.querySelectorAll('.wizard-field input').length).toBe(3);
    expect(screen.queryByText(/扫描|自动枚举/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'ADB' }));
    expect((screen.getByLabelText('串口') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('波特率') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByLabelText('串口')).toBeTruthy();
    expect((screen.getByLabelText('板子名字') as HTMLInputElement).disabled).toBe(false);
  });

  it('**串口提交的是人填的值**，跑时按钮禁用并说出正在做什么', () => {
    const run = pendingRun();
    const { container } = render(<WizardPage run={run} />);
    fill('COM7', '我的板');

    fireEvent.click(screen.getByRole('button', { name: '开始接板' }));

    expect(run).toHaveBeenCalledWith({
      transport: 'serial',
      port: 'COM7',
      baudrate: 1500000,
      boardName: '我的板',
    });
    const button = screen.getByRole('button', { name: '正在接板…' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('.wizard-wait__title')?.textContent).toBe('建立第一个真相');
    expect(screen.getByRole('status').textContent).toContain('不编百分比');
  });

  it('**ADB 提交不拿串口和波特率**（宿主会忽略，但界面别装作用得上）', () => {
    const run = pendingRun();
    render(<WizardPage run={run} />);
    fireEvent.change(screen.getByLabelText('板子名字'), { target: { value: '我的板' } });
    fireEvent.click(screen.getByRole('button', { name: 'ADB' }));
    fireEvent.click(screen.getByRole('button', { name: '开始接板' }));

    expect(run).toHaveBeenCalledWith({
      transport: 'adb',
      port: '',
      baudrate: 0,
      boardName: '我的板',
    });
  });

  it('等待时间推进后换下一段名字，仍然不报百分比', () => {
    vi.useFakeTimers();
    try {
      const run = pendingRun();
      const { container } = render(<WizardPage run={run} />);
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

  it('**成功**：主视觉、可用数、包路径、初版说明，并通知外壳刷新', async () => {
    const run = vi.fn(() => Promise.resolve(BASE));
    const onInstalled = vi.fn();
    const { container } = render(<WizardPage run={run} onInstalled={onInstalled} />);
    fill();

    fireEvent.click(screen.getByRole('button', { name: '开始接板' }));

    expect(await screen.findByText('这块板现在有自己的包了')).toBeTruthy();
    expect(container.querySelector('.wizard-result__title')?.textContent).toBe(
      '这块板现在有自己的包了',
    );
    expect(container.querySelector('.wizard-result__summary')?.textContent).toContain('12');
    expect(container.querySelector('.wizard-result__summary')?.textContent).toContain('1');
    expect(screen.getByText(BASE.installedDir as string)).toBeTruthy();
    expect(screen.getByText(/这是自动探出来的初版包/)).toBeTruthy();
    expect(screen.getByText('板的 id · my-board')).toBeTruthy();
    expect(onInstalled).toHaveBeenCalledTimes(1);
  });

  it('**串口打不开**：先怀疑端口被别的东西占着', async () => {
    const run = vi.fn(() =>
      Promise.resolve({
        ...BASE,
        ok: false,
        kind: 'port-unopenable' as const,
        message: '**串口打不开** —— Opening COM9: Access denied',
        greenCount: 0,
        redCount: 0,
        installedDir: undefined,
      }),
    );
    const { container } = render(<WizardPage run={run} />);
    fill('COM9');

    fireEvent.click(screen.getByRole('button', { name: '开始接板' }));

    expect(await screen.findByText(/Access denied/)).toBeTruthy();
    expect(container.querySelector('.wizard-result__title')?.textContent).toBe('串口打不开');
    expect(screen.getByText(/有别的程序正独占着那个口/)).toBeTruthy();
  });

  it('**板子没说话**：不说「连接失败」，hints 逐条列', async () => {
    const run = vi.fn(() =>
      Promise.resolve({
        ...BASE,
        ok: false,
        kind: 'no-reply' as const,
        message: '**板子没说话** —— 连上了，但命令没有回包',
        greenCount: 0,
        redCount: 0,
        installedDir: undefined,
      }),
    );
    const { container } = render(<WizardPage run={run} />);
    fill();

    fireEvent.click(screen.getByRole('button', { name: '开始接板' }));

    expect(await screen.findByText(/连上了，但命令没有回包/)).toBeTruthy();
    expect(container.querySelector('.wizard-result__title')?.textContent).toBe('板子没说话');
    expect(container.textContent).not.toContain('连接失败');
    expect(container.querySelectorAll('.wizard-hints li').length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText(/1500000/).length).toBeGreaterThan(0);
  });

  it('**那条连接一次都没通**：先查连接，不是元操作', async () => {
    const run = vi.fn(() =>
      Promise.resolve({
        ...BASE,
        ok: false,
        kind: 'connection-dead' as const,
        message: '**一个数都没出来** —— 不是元操作的问题',
        greenCount: 0,
        redCount: 0,
        installedDir: undefined,
      }),
    );
    render(<WizardPage run={run} />);
    fill();

    fireEvent.click(screen.getByRole('button', { name: '开始接板' }));

    expect(await screen.findByText('那条连接一次都没通')).toBeTruthy();
    expect(screen.getByText(/先查连接本身/)).toBeTruthy();
  });
});

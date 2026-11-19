import { describe, it, expect, vi } from 'vitest';
import { SerialConnection, type SerialPortFactory } from '../../src/main/hal/serial';

/**
 * 串口 exec 超时的**失败形态**。
 *
 * ── 为什么这条要单独测 ──
 *
 * 真机上真踩过（2026-11-13）：宿主上计划 1 验收留下的 `serial-server.py`
 * **独占打开了 COM3**，回包被它吃掉——
 * **板子是活的、串口是通的，但应用自己的 exec 永远收不到**。
 *
 * 这时应用看到的只有「超时」——而「超时」的第一嫌疑应该是
 * 「**回包被别的程序吃了**」，不是「板子慢」。
 *
 * **判据是「消息里有没有可执行的下一步」，不是「消息好不好听」。**
 */

const log = { write: vi.fn(), close: vi.fn(), filePath: 'x' };

/** 一个「开了口但永远不回话」的串口 —— 模拟回包被别的程序吃掉 */
function silentPort(): SerialPortFactory {
  return async () => ({
    write() {
      // 什么都不回 —— 回包被别处吃掉了
    },
    onData() {
      /* no-op */
    },
    onError() {
      /* no-op */
    },
    async close() {
      /* no-op */
    },
  });
}

function makeConnection(port: string): SerialConnection {
  return new SerialConnection(
    {
      id: 's',
      label: 's',
      transport: 'serial',
      options: { port, baudrate: 1500000 },
    },
    log as never,
    silentPort(),
  );
}

describe('串口 exec 超时 → 说清楚「下一步查什么」', () => {
  it('超时的结果里带一条提示，**包含端口名**', async () => {
    const conn = makeConnection('COM7');
    await conn.open();

    const result = await conn.exec('echo hello', { timeoutMs: 30 });

    expect(result.timedOut).toBe(true);
    // **统一 124 这条约定不许改**（事实 G1）
    expect(result.exitCode).toBe(124);
    expect(result.hint).toBeTruthy();
    expect(result.hint).toContain('swallowed');
    expect(result.hint).toContain('COM7');
  });

  it('提示里点名**串口独占**这个坑（真机上真踩过）', async () => {
    const conn = makeConnection('COM3');
    await conn.open();

    const result = await conn.exec('echo hello', { timeoutMs: 30 });

    expect(result.hint).toContain('serial port');
  });
});

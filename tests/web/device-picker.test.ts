import { describe, it, expect } from 'vitest';
import type { ConnectionInfo } from '../../src/shared/ipc-contract';
import { groupByDevice } from '../../src/renderer/shell/devices';

/**
 * **按设备分组**（`devices.ts`）。
 *
 * ── 为什么有这一层 ──
 *
 * → **板实物与连接是两层** ✓（契约 `spec/02` §10.2 ✓）——
 * 一块板有 **ADB / 串口 / SSH** 三条连接 ✓ → **界面要按板子分组** ✓。
 * → 之前只有「连接」这一层 ✓ → 界面只能说「板子 · ADB」✓
 *   → **用户看到的是三条连接，不是三块板** ✗。
 *
 * → **`device_key` 就是「哪块板」** ✓ —— **同一块板的多条连接给同一个值** ✓。
 */
function conn(
  id: string,
  deviceKey: string,
  overrides: Partial<ConnectionInfo> = {},
): ConnectionInfo {
  return {
    id,
    label: id,
    transport: 'adb',
    boardPack: 'rk3588-atk',
    deviceKey,
    current: false,
    capabilities: { exec: true, pty: false, files: true, exitCode: true },
    ...overrides,
  };
}

describe('按设备分组', () => {
  it('**同一块板的多条连接归到一组** ✓', () => {
    const groups = groupByDevice([
      conn('board-adb', 'atk-01', { label: '板子 · ADB' }),
      conn('board-serial', 'atk-01', { label: '板子 · 串口', transport: 'serial' }),
      conn('board-ssh', 'atk-01', { label: '板子 · SSH', transport: 'ssh' }),
      conn('guest', 'guest', { label: '客机', transport: 'ssh' }),
    ]);
    expect(groups.map((g) => g.deviceKey)).toEqual(['atk-01', 'guest']);
    expect(groups[0]?.connections.map((c) => c.id)).toEqual([
      'board-adb',
      'board-serial',
      'board-ssh',
    ]);
  });

  it('**当前那块排第一** ✓（**选板的人先看到自己在用哪块** ✓）', () => {
    const groups = groupByDevice([
      conn('guest', 'guest', { label: '客机', transport: 'ssh' }),
      conn('board-adb', 'atk-01', { label: '板子 · ADB', current: true }),
    ]);
    expect(groups.map((g) => g.deviceKey)).toEqual(['atk-01', 'guest']);
  });

  it('**每组说得出「当前运行时用的是哪条连接」** ✓（**没有就是 `null`** ✓ —— **不猜** ✓）', () => {
    const groups = groupByDevice([
      conn('board-adb', 'atk-01', { current: true }),
      conn('board-ssh', 'atk-01'),
      conn('guest', 'guest'),
    ]);
    expect(groups[0]?.currentProfileId).toBe('board-adb');
    expect(groups[1]?.currentProfileId).toBeNull();
  });

  it('**一块板只有一个 `current` 连接** ✓ —— **两处说「当前」就是数据乱了** ✓', () => {
    const groups = groupByDevice([
      conn('board-adb', 'atk-01', { current: true }),
      conn('board-ssh', 'atk-01', { current: true }),
    ]);
    // **只认第一条** ✓（**不猜第二个是谁** ✓）
    expect(groups[0]?.currentProfileId).toBe('board-adb');
  });

  it('**没有连接就是空数组** ✓（**不是「一块都没有的板」** ✓）', () => {
    expect(groupByDevice([])).toEqual([]);
  });
});

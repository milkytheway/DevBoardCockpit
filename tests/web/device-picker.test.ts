import { describe, it, expect } from 'vitest';
import type { ConnectionInfo } from '../../src/shared/ipc-contract';
import { boardsOf } from '../../src/renderer/shell/devices';

/**
 * **界面只列板卡**（`devices.ts`）。
 *
 * ── 为什么要有这一层 ──
 *
 * → **板实物与连接是两层** ✓（契约 `spec/02` §10.2 ✓）——
 *   一块板有 **ADB / 串口 / SSH** 三条连接 ✓ → **界面要按板子分组** ✓。
 * → 用户 2026-11-16 明确：「**仅支持板卡选择，不要把连接放进去**」✓
 *   → **界面那一层只认板** ✓ → **连接由宿主挑** ✓。
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

describe('按板子归并', () => {
  it('**同一块板的多条连接归成一块板** ✓', () => {
    const boards = boardsOf([
      conn('board-adb', 'atk-01', { label: '板子 · ADB' }),
      conn('board-serial', 'atk-01', { label: '板子 · 串口', transport: 'serial' }),
      conn('board-ssh', 'atk-01', { label: '板子 · SSH', transport: 'ssh' }),
      conn('guest', 'guest', { label: '客机', transport: 'ssh' }),
    ]);
    expect(boards.map((b) => b.deviceKey)).toEqual(['atk-01', 'guest']);
    expect(boards[0]?.connectionCount).toBe(3);
  });

  it('**当前那块排第一** ✓（**选板的人先看到自己在用哪块** ✓）', () => {
    const boards = boardsOf([
      conn('guest', 'guest', { label: '客机', transport: 'ssh' }),
      conn('board-adb', 'atk-01', { label: '板子 · ADB', current: true }),
    ]);
    expect(boards.map((b) => b.deviceKey)).toEqual(['atk-01', 'guest']);
    expect(boards[0]?.current).toBe(true);
    expect(boards[1]?.current).toBe(false);
  });

  it('**板型包就是那块板的型号** ✓', () => {
    const boards = boardsOf([
      conn('board-adb', 'atk-01', { boardPack: 'rk3588-atk' }),
      conn('fake-board', 'fake-board', { boardPack: 'rk3588-atk' }),
    ]);
    expect(boards.map((b) => b.boardPack)).toEqual(['rk3588-atk', 'rk3588-atk']);
  });

  it('**没绑板型包的连接不是板子** ✓（**本机 / 客机不是板** ✓）', () => {
    const boards = boardsOf([
      conn('local', 'local', { boardPack: null, transport: 'local' }),
      conn('guest', 'guest', { boardPack: null, transport: 'ssh' }),
      conn('board-adb', 'atk-01', { boardPack: 'rk3588-atk' }),
    ]);
    // **只有绑了板型包的才是板** ✓ —— 与运行时候选同一把尺 ✓（`tags/runtime.ts` ✓）
    expect(boards.map((b) => b.deviceKey)).toEqual(['atk-01']);
  });

  it('**一块板只有一个 `current`** ✓ —— **两处说「当前」就是数据乱了** ✓', () => {
    const boards = boardsOf([
      conn('board-adb', 'atk-01', { current: true }),
      conn('board-ssh', 'atk-01', { current: true }),
    ]);
    // **只认第一条** ✓（**不猜第二个是谁** ✓）
    expect(boards[0]?.current).toBe(true);
    expect(boards.length).toBe(1);
  });

  it('**没有连接就是空数组** ✓（**不是「一块都没有的板」** ✓）', () => {
    expect(boardsOf([])).toEqual([]);
  });
});

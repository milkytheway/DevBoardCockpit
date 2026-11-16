import { describe, it, expect } from 'vitest';
import { selectDevice } from '../../../src/main/profiles/device-select';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';
import type { RuntimeStatus } from '../../../src/shared/runtime-status';

/**
 * **选板子 = 宿主挑连接**（板实物与连接是两层 ✓ —— 契约 `spec/02` §10.2 ✓）。
 *
 * ── 为什么宿主挑 ──
 *
 * → 界面**只列板卡** ✓（用户 2026-11-16 明确：「仅支持板卡选择，不要把连接放进去」✓）
 * → 一块板有 **ADB / 串口 / SSH** 三条连接 ✓ → **哪条能用宿主才知道** ✓
 * → 界面挑 → **不静默地做另一件事** ✗ → **连不上要说出来** ✓。
 *
 * ── 三条规矩 ──
 *
 * | # | 规矩 | 为什么 |
 * |---|---|---|
 * | 1 | **已经在那块板上 → 不重连** ✓ | **白连一次会掉读数** ✗ —— 采样器会重起 ✓ |
 * | 2 | **挨个试这块板的连接** ✓ | **用户点的是板，不是某条通道** ✓ → 宿主挑一条能用的 ✓ |
 * | 3 | **全都不行 → 报错** ✓ | **不静默地换一块板** ✗ |
 */

/** 一条连接 profile（**只填这里用得上的字段** ✓） */
function profile(id: string, deviceKey: string, label = id): ConnectionProfile {
  return {
    id,
    label,
    transport: 'adb',
    board_pack: 'rk3588-atk',
    device_key: deviceKey,
    options: {},
  };
}

const ATK: ConnectionProfile[] = [
  profile('board-adb', 'atk-01', '板子 · ADB'),
  profile('board-serial', 'atk-01', '板子 · 串口'),
  profile('board-ssh', 'atk-01', '板子 · SSH'),
  profile('fake-board', 'fake-board', '假板子 · 合成数据'),
];

/** 一次「起运行时」的记录 —— 用来断言宿主到底试了哪几条 */
interface Attempt {
  profileId: string;
  status: RuntimeStatus;
}

function runtime(
  results: Record<string, RuntimeStatus>,
  current: string | null = null,
): { attempts: Attempt[]; deps: Parameters<typeof selectDevice>[2] } {
  const attempts: Attempt[] = [];
  return {
    attempts,
    deps: {
      currentProfileId: () => current,
      start: async (p: ConnectionProfile) => {
        const status = results[p.id] ?? { state: 'error', detail: `没有为 ${p.id} 安排结果` };
        attempts.push({ profileId: p.id, status });
        return status;
      },
    },
  };
}

describe('选板子', () => {
  it('**板子 → 宿主挑它的第一条连接** ✓（**用户点的是板，不是通道** ✓）', async () => {
    const rt = runtime({ 'board-adb': { state: 'running' } });
    const result = await selectDevice(ATK, 'atk-01', rt.deps);
    expect(result).toEqual({ ok: true, profileId: 'board-adb', reused: false });
    expect(rt.attempts.map((a) => a.profileId)).toEqual(['board-adb']);
  });

  it('**已经在那块板上 → 不重连** ✓（**白连一次会掉读数** ✗）', async () => {
    const rt = runtime({}, 'board-ssh');
    const result = await selectDevice(ATK, 'atk-01', rt.deps);
    expect(result).toEqual({ ok: true, profileId: 'board-ssh', reused: true });
    // **一次都没起** ✓ —— 采样器没有被重启 ✓
    expect(rt.attempts).toEqual([]);
  });

  it('**第一条连不上 → 试下一条** ✓（**这块板还有别的通道** ✓）', async () => {
    const rt = runtime({
      'board-adb': { state: 'error', detail: 'adb: device not found' },
      'board-serial': { state: 'error', detail: '串口 COM3 不存在' },
      'board-ssh': { state: 'running' },
    });
    const result = await selectDevice(ATK, 'atk-01', rt.deps);
    expect(result).toEqual({ ok: true, profileId: 'board-ssh', reused: false });
    expect(rt.attempts.map((a) => a.profileId)).toEqual([
      'board-adb',
      'board-serial',
      'board-ssh',
    ]);
  });

  it('**全都不行 → 报错** ✓（**不静默地换一块板** ✗ —— 那是「静默地做另一件事」✗）', async () => {
    const rt = runtime({
      'board-adb': { state: 'error', detail: 'adb: device not found' },
    });
    const result = await selectDevice(ATK, 'atk-01', rt.deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('connect_failed');
    // **说清楚每一条都试过了** ✓ —— 不是一个含糊的「失败了」✓
    expect(result.detail).toContain('board-adb');
    expect(result.detail).toContain('board-ssh');
  });

  it('**没有这个设备 → not_found** ✓（**不猜** ✓）', async () => {
    const rt = runtime({});
    const result = await selectDevice(ATK, 'atk-99', rt.deps);
    expect(result).toEqual({ ok: false, reason: 'not_found', detail: '没有这个设备：atk-99' });
    expect(rt.attempts).toEqual([]);
  });

  it('**假板子也是一块板** ✓（**它的连接也是它的** ✓）', async () => {
    const rt = runtime({ 'fake-board': { state: 'running' } });
    const result = await selectDevice(ATK, 'fake-board', rt.deps);
    expect(result).toEqual({ ok: true, profileId: 'fake-board', reused: false });
  });

  it('**没有 `device_key` 的 profile 归到它自己名下** ✓（**一板一连的老写法** ✓）', async () => {
    const legacy: ConnectionProfile = {
      id: 'legacy-ssh',
      label: '老连接',
      transport: 'ssh',
      board_pack: 'rk3588-atk',
      options: {},
    };
    const rt = runtime({ 'legacy-ssh': { state: 'running' } });
    const result = await selectDevice([legacy], 'legacy-ssh', rt.deps);
    expect(result).toEqual({ ok: true, profileId: 'legacy-ssh', reused: false });
  });
});

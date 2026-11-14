import { describe, it, expect } from 'vitest';
import { profilesWithFake, fakeRouteFor } from '../../src/main/hal/fake/wiring';
import { FAKE_PROFILE_ID } from '../../src/main/hal/fake/profile';
import type { ConnectionProfile } from '../../src/main/profiles/schema';

/**
 * 假设备的**接线规则**（纯函数，所以能单测）。
 *
 * ── 为什么规则要单独成文件 ──
 *
 * `main/index.ts` 引了 Electron，**单测进不去**——
 * 而这几条恰恰是「静默失效」的重灾区：
 * 假设备没载入成功时，profile 还在列表里，
 * 而连接回落成了**真本机连接**（Windows 上就是开发者自己的 cmd.exe）：
 * 列表里写着「假板子 · 合成数据」，打开却是自己的机器。
 *
 * → 规则抽成纯函数，**判据能单测**。
 */

const REAL: ConnectionProfile = {
  id: 'board-adb',
  label: '真板子',
  transport: 'adb',
  board_pack: 'rk3588-atk',
  options: {},
};

describe('假设备 · 接线规则', () => {
  it('开关关着 → 不列假 profile', () => {
    expect(profilesWithFake([REAL], 'off', true)).toEqual([REAL]);
  });

  it('开着 → 假 profile 排第一个（调试时看到的一定是它）', () => {
    const out = profilesWithFake([REAL], 'on', true);
    expect(out[0]?.id).toBe(FAKE_PROFILE_ID);
    expect(out).toHaveLength(2);
  });

  it('only → 只有假 profile', () => {
    const out = profilesWithFake([REAL], 'only', true);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe(FAKE_PROFILE_ID);
  });

  it('假设备没载入成功 → 就不列它（列了会拿真的本机连接顶替）', () => {
    expect(profilesWithFake([REAL], 'on', false)).toEqual([REAL]);
    expect(profilesWithFake([REAL], 'only', false)).toEqual([REAL]);
  });

  it('路由：载入成功才走假设备；没载入成功就**拒绝**，绝不回落成真连接', () => {
    expect(fakeRouteFor(FAKE_PROFILE_ID, 'on', true)).toBe('fake');
    // **'refuse' 而不是 'not-fake'** —— 后者会掉进真的传输里
    expect(fakeRouteFor(FAKE_PROFILE_ID, 'on', false)).toBe('refuse');
    expect(fakeRouteFor('board-adb', 'on', true)).toBe('not-fake');
    expect(fakeRouteFor('board-adb', 'off', true)).toBe('not-fake');
  });
});

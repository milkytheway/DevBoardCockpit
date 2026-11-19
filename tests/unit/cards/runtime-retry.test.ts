import { describe, it, expect } from 'vitest';
import {
  pickCandidates,
  startWithRetry,
  isPortBusy,
  RETRY_BACKOFF_MS,
  type RuntimeStatus,
} from '../../../src/main/tags/runtime';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';

/**
 * 运行时「起不来了怎么办」的三个决定。
 *
 * ── 三个真 bug（`docs/19` P1/P2，2026-11-13 实测）──
 *
 * | # | 现状 | 后果 |
 * |---|---|---|
 * | P2 | 候选过滤用 `board_pack !== undefined` | `board_pack: null` 的 profile（`local` / `ubuntu-ssh`）**被当成候选** → 运行时去连本机和 SSH 客机，白开两条连接，还可能**抢串口** |
 * | P1 | 候选各试一次就放弃 | 板子后插上，**面板永远空着**，必须重启应用 |
 * | — | 串口被终端占了也照样往下试 | 一次失败的串口尝试可能**占着端口不放**，把能用的 adb 挤掉 |
 *
 * 判据全在这里：**候选是谁 · 失败了还试不试下一个 · 什么时候重试**。
 */

/** 造一个最小可用的 profile。`board_pack` 缺省 = 这个字段根本没写 */
function profile(id: string, boardPack: string | null | undefined): ConnectionProfile {
  return {
    id,
    label: id,
    transport: 'adb',
    ...(boardPack === undefined ? {} : { board_pack: boardPack }),
    options: {},
  };
}

describe('运行时候选筛选', () => {
  it('只留绑了板型包的 profile —— null 与缺省都剔掉', () => {
    const candidates = pickCandidates([
      profile('local', null),
      profile('no-pack', undefined),
      profile('board', 'rk3588-atk'),
    ]);
    expect(candidates.map((c) => c.profileId)).toEqual(['board']);
  });

  it('绑了板型包的候选原样带出 profile（后面要拿它去建连接）', () => {
    const [candidate] = pickCandidates([profile('board', 'rk3588-atk')]);
    expect(candidate?.profile.id).toBe('board');
    expect(candidate?.profile.board_pack).toBe('rk3588-atk');
  });
});

describe('端口被占的判据', () => {
  it('认得出 PORT_BUSY 的错误码', () => {
    expect(isPortBusy('serial port COM3 is busy', 'PORT_BUSY')).toBe(true);
  });

  it('认不出别的失败', () => {
    expect(isPortBusy('adb: device offline')).toBe(false);
    expect(isPortBusy('cannot connect', 'CONN_OPEN_FAILED')).toBe(false);
  });
});

describe('起运行时的重试', () => {
  it('某个候选因端口被占失败时，继续试下一个', async () => {
    const attempts: string[] = [];
    const runtime = {
      async start(p: ConnectionProfile): Promise<RuntimeStatus> {
        attempts.push(p.id);
        if (p.id === 'serial') {
          return { state: 'error', detail: '串口 COM3 被占用', detailCode: 'PORT_BUSY' };
        }
        return { state: 'running', profileId: p.id };
      },
    };

    const status = await startWithRetry(
      runtime,
      pickCandidates([profile('serial', 'rk3588-atk'), profile('adb', 'rk3588-atk')]),
      { sleep: async () => undefined },
    );

    expect(attempts).toEqual(['serial', 'adb']);
    expect(status.state).toBe('running');
  });

  it('全部失败时按退避重试，档位用尽后停', async () => {
    const slept: number[] = [];
    let calls = 0;
    const runtime = {
      async start(): Promise<RuntimeStatus> {
        calls += 1;
        return { state: 'error', detail: '连不上' };
      },
    };

    const status = await startWithRetry(runtime, pickCandidates([profile('a', 'rk3588-atk')]), {
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    });

    expect(slept).toEqual([...RETRY_BACKOFF_MS]);
    expect(calls).toBe(RETRY_BACKOFF_MS.length + 1);
    expect(status.state).toBe('error');
  });

  it('候选为空时直接报错，不空转', async () => {
    const runtime = {
      async start(): Promise<RuntimeStatus> {
        throw new Error('不该被调用');
      },
    };
    const status = await startWithRetry(runtime, [], { sleep: async () => undefined });
    expect(status.state).toBe('error');
    expect(status.detail).toMatch(/no connection carries a board pack/);
  });

  it('端口被占的候选不再重试（占着端口的是别的程序，等它退出才有用）', async () => {
    const attempts: string[] = [];
    const runtime = {
      async start(p: ConnectionProfile): Promise<RuntimeStatus> {
        attempts.push(p.id);
        if (p.id === 'serial') {
          return { state: 'error', detail: '串口 COM3 被占用', detailCode: 'PORT_BUSY' };
        }
        return { state: 'error', detail: '板子还没起来' };
      },
    };

    await startWithRetry(
      runtime,
      pickCandidates([profile('serial', 'rk3588-atk'), profile('adb', 'rk3588-atk')]),
      { sleep: async () => undefined },
    );

    // serial 只试了一次（第一轮），之后每轮都只试 adb
    expect(attempts.filter((id) => id === 'serial')).toHaveLength(1);
    expect(attempts.filter((id) => id === 'adb')).toHaveLength(RETRY_BACKOFF_MS.length + 1);
  });
});

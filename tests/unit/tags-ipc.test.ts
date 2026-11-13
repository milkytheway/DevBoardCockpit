import { describe, it, expect, vi } from 'vitest';

/**
 * tag 读数的 IPC 通道。
 *
 * ── 为什么这两条通道是「判据」而不只是「实现」──
 *
 * 契约 §2.1 的五态迁移是**有状态的**（ADR-D22）：
 * 「读数只经 TagStore 进、只经 TagStore 出」。
 * 所以 renderer 侧**只能**拿到两种东西：
 * 1. **当前快照**（`tags:readings`）——晚订阅的人**不会丢当前值**；
 * 2. **变化推送**（`tags:changed`）——值自己会动。
 *
 * **只推不取**会漏掉晚订阅的人；**只取不推**则值不会自己动。
 * 两条都要有——这就是它们为什么是判据。
 */

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  exposed: {} as Record<string, unknown>,
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: unknown): void => {
      mocks.exposed = api as Record<string, unknown>;
    },
  },
  ipcRenderer: {
    invoke: mocks.invoke,
    send: mocks.send,
    on: mocks.on,
    off: mocks.off,
  },
  webUtils: {
    getPathForFile: (file: File): string => `C:\\Users\\me\\${file.name}`,
  },
}));

import { IPC } from '../../src/shared/ipc-contract';
import { api } from '../../src/preload/index';

describe('tag 读数的 IPC 通道', () => {
  it('通道名拼错要在**编译期**就红——这就是 IPC 表存在的理由', () => {
    expect(IPC.tagsReadings).toBe('tags:readings');
    expect(IPC.tagsChanged).toBe('tags:changed');
  });

  it('preload 暴露了「取快照」与「听变化」两个方法', () => {
    expect(typeof api.tagsReadings).toBe('function');
    expect(typeof api.onTagChanged).toBe('function');
  });

  it('取快照走 invoke，并回到主进程给的结果', async () => {
    const snapshot = [
      { tag: 'cpu.usage', value: 12.5, unit: 'percent', status: 'ok', at: 1, seq: 1 },
    ];
    mocks.invoke.mockResolvedValue({ ok: true, value: snapshot });

    await expect(api.tagsReadings()).resolves.toEqual(snapshot);
    expect(mocks.invoke).toHaveBeenCalledWith('tags:readings');
  });

  it('听变化：订阅拿得到推送，**退订后不再拿得到**', () => {
    const seen: unknown[] = [];
    const off = api.onTagChanged((reading) => seen.push(reading));

    expect(mocks.on).toHaveBeenCalledWith('tags:changed', expect.any(Function));

    // 模拟主进程推一次
    const handler = mocks.on.mock.calls[0]?.[1] as (e: unknown, r: unknown) => void;
    const reading = { tag: 'cpu.usage', value: 1, unit: 'percent', status: 'ok', at: 1, seq: 2 };
    handler({}, reading);
    expect(seen).toEqual([reading]);

    off();
    expect(mocks.off).toHaveBeenCalledWith('tags:changed', expect.any(Function));
  });
});

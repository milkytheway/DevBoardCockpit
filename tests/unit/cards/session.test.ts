import { describe, it, expect } from 'vitest';
import { CardSessionManager } from '../../../src/main/cards/session';
import type { CardPermissions } from '../../../src/main/cards/permissions';

/**
 * 卡片会话的**资源生命周期**（RF-4）。
 *
 * ── 问题 ──
 *
 * 卡片是 AI 写的任意网页。它可以：
 *
 * | 行为 | 后果（不处理的话） |
 * |---|---|
 * | 反复 `tags.subscribe` | 运行时上挂 N 个监听器 → 每次推送都 fan-out N 份 → main 的内存与 IPC 被打满 |
 * | 把卡片删了 / 改了文件重载 | 旧会话的订阅**永远不释放** → 同样的泄漏 |
 *
 * 契约 §六：「**单卡崩溃不影响其他卡，也不影响工作台**」——
 * 「影响」在这里就是「把 main 打满」。
 *
 * ── 两条防线 ──
 *
 * 1. **关掉会话 → 退订函数真的被调用**（订阅不再推）
 * 2. **订阅数有上限** → 超了回 `{ ok:false, reason:'too_many_subscriptions' }`
 */
const PERMS: CardPermissions = { read: ['cpu.usage'], write: [] };

function managerWith(
  runtime: { readings: () => never[]; subscribe: (cb: (r: never) => void) => () => void },
  perms: CardPermissions = PERMS,
): CardSessionManager {
  return new CardSessionManager({
    runtime: runtime as never,
    permsFor: () => perms,
    now: () => 1000,
  });
}

describe('会话 · 退订真的释放', () => {
  it('**关掉会话 → 订阅的退订函数被调用**', async () => {
    let released = 0;
    const m = managerWith({
      readings: () => [],
      subscribe: () => () => {
        released += 1;
      },
    });
    m.open('inst-1', 'cpu-usage', 'board-a');
    await m.handle({
      instanceId: 'inst-1',
      id: 'r1',
      method: 'tags.subscribe',
      args: { name: 'cpu.usage', subscriptionId: 's1' },
    });
    expect(released).toBe(0);
    m.close('inst-1');
    expect(released).toBe(1);
  });

  it('关掉会话 → 那个实例的请求也不再被受理', async () => {
    const m = managerWith({ readings: () => [], subscribe: () => () => undefined });
    m.open('inst-1', 'cpu-usage', 'board-a');
    m.close('inst-1');
    const res = await m.handle({
      instanceId: 'inst-1',
      id: 'r1',
      method: 'tags.get',
      args: { name: 'cpu.usage' },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unknown_instance');
  });
});

describe('会话 · 订阅数有上限（一张卡不能把 main 打满）', () => {
  it('超过上限 → 回 too_many_subscriptions（**不是**静默接受）', async () => {
    const m = managerWith({ readings: () => [], subscribe: () => () => undefined });
    m.open('inst-1', 'cpu-usage', 'board-a');
    let last = '';
    for (let i = 0; i < 200; i += 1) {
      const res = await m.handle({
        instanceId: 'inst-1',
        id: `r${i}`,
        method: 'tags.subscribe',
        args: { name: 'cpu.usage', subscriptionId: `s${i}` },
      });
      if (!res.ok) {
        last = res.reason ?? '';
        break;
      }
    }
    expect(last).toBe('too_many_subscriptions');
  });

  it('上限之内 → 全部受理', async () => {
    const m = managerWith({ readings: () => [], subscribe: () => () => undefined });
    m.open('inst-1', 'cpu-usage', 'board-a');
    for (let i = 0; i < 10; i += 1) {
      const res = await m.handle({
        instanceId: 'inst-1',
        id: `r${i}`,
        method: 'tags.subscribe',
        args: { name: 'cpu.usage', subscriptionId: `s${i}` },
      });
      expect(res.ok).toBe(true);
    }
  });
});

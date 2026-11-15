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
  workflowsFor?: (cardId: string) => {
    list(): unknown;
    run(id: string, inputs: Record<string, unknown>): unknown;
    status(runId: string): unknown;
  },
): CardSessionManager {
  return new CardSessionManager({
    runtime: runtime as never,
    permsFor: () => perms,
    now: () => 1000,
    ...(workflowsFor === undefined ? {} : { workflowsFor }),
  });
}

/** 流程侧的假实现（**记下调用** ✓ —— 判据要看「有没有真被调到」✓） */
function fakeWorkflows(calls: string[]): {
  list(): unknown;
  run(id: string, inputs: Record<string, unknown>): unknown;
  status(runId: string): unknown;
} {
  return {
    list: () => {
      calls.push('list');
      return [];
    },
    run: (id: string) => {
      calls.push(`run:${id}`);
      return { ok: true, runId: 'wf-1' };
    },
    status: (runId: string) => {
      calls.push(`status:${runId}`);
      return { ok: true, runId };
    },
  };
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

describe('会话 · 流程的**第四维授权**（契约 §3.3）', () => {
  it('**不在 `permissions.workflows` 里 → denied**（流程 id 不许混进 write ✓）', async () => {
    const calls: string[] = [];
    const m = managerWith(
      { readings: () => [], subscribe: () => () => undefined },
      { read: [], write: [], workflows: ['other.run'] },
      () => fakeWorkflows(calls),
    );
    m.open('inst-1', 'cpu-usage', 'board-a');
    const res = await m.handle({
      instanceId: 'inst-1',
      id: 'r1',
      method: 'workflows.run',
      args: { id: 'demo.run', inputs: {} },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('denied');
    // **实现压根没被调到** ✓（权限没过就不该有副作用 ✓）
    expect(calls).toEqual([]);
  });

  it('**在 `permissions.workflows` 里 → 放行** ✓', async () => {
    const calls: string[] = [];
    const m = managerWith(
      { readings: () => [], subscribe: () => () => undefined },
      { read: [], write: [], workflows: ['demo.run'] },
      () => fakeWorkflows(calls),
    );
    m.open('inst-1', 'cpu-usage', 'board-a');
    const res = await m.handle({
      instanceId: 'inst-1',
      id: 'r1',
      method: 'workflows.run',
      args: { id: 'demo.run', inputs: {} },
    });
    expect(res.ok).toBe(true);
    expect(calls).toEqual(['run:demo.run']);
  });

  it('**流程的授权不靠 `permissions.write`**（两维各看各的 ✓）', async () => {
    const calls: string[] = [];
    const m = managerWith(
      { readings: () => [], subscribe: () => () => undefined },
      // **write 里有它、workflows 里没有** → 仍然被拒 ✓
      { read: [], write: ['demo.run'], workflows: [] },
      () => fakeWorkflows(calls),
    );
    m.open('inst-1', 'cpu-usage', 'board-a');
    const res = await m.handle({
      instanceId: 'inst-1',
      id: 'r1',
      method: 'workflows.run',
      args: { id: 'demo.run', inputs: {} },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('denied');
  });
});

describe('会话 · 动作的**结果**不被塌成信封失败', () => {
  /**
   * ── 为什么这条重要 ──
   *
   * 契约 `spec/04` §2.4 的动作结果**自己就有 `ok` 与 `reason`**：
   * `{ ok:false, reason:'needs_confirmation', needsConfirmation:{confirmId} }`。
   *
   * 而会话层有一条通用规矩：「方法自己返回的失败要提到信封上」——
   * 对 `tags.subscribe`（回 `{ok:false, reason:'too_many_subscriptions'}`）是对的，
   * 对**动作结果**却是错的：
   * **塌掉之后 `confirm_id` 丢了** → 卡片永远没法完成确认 → 确认通道形同虚设。
   *
   * → 结果**形状**的方法（动作）**不塌**：信封说「方法跑完了」，
   * 结果（成功与否）由卡片自己读 `value.ok`（契约就是这么写的）。
   */
  it('要人确认时，卡片拿得到 confirm_id', async () => {
    const m = new CardSessionManager({
      runtime: { readings: () => [], subscribe: () => () => undefined } as never,
      permsFor: () => ({ read: [], write: ['backlight.set'] }),
      actionsFor: () => ({
        invoke: () => ({
          ok: false,
          verified: false,
          reason: 'needs_confirmation',
          needsConfirmation: { confirmId: 'confirm-1', detail: '这个动作要人确认' },
        }),
      }),
    });
    m.open('inst-1', 'action-card', 'board-a');
    const res = await m.handle({
      instanceId: 'inst-1',
      id: 'r1',
      method: 'actions.invoke',
      args: { id: 'backlight.set', params: { value: 128 } },
    });
    // **信封是成功的**（方法跑完了）——结果在 value 里
    expect(res.ok).toBe(true);
    const value = res.value as {
      ok: boolean;
      reason: string;
      needsConfirmation: { confirmId: string };
    };
    expect(value.reason).toBe('needs_confirmation');
    expect(value.needsConfirmation.confirmId).toBe('confirm-1');
  });

  it('但**方法级**的失败仍然塌成信封失败（老规矩不变）', async () => {
    const m = managerWith({ readings: () => [], subscribe: () => () => undefined });
    m.open('inst-1', 'cpu-usage', 'board-a');
    const res = await m.handle({
      instanceId: 'inst-1',
      id: 'r1',
      method: 'tags.subscribe',
      args: { name: 'cpu.usage', subscriptionId: 's1' },
    });
    // 订阅数没超上限 → 不该失败
    expect(res.ok).toBe(true);
  });
});

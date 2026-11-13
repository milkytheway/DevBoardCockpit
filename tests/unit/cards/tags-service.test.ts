import { describe, it, expect } from 'vitest';
import { TagsService } from '../../../src/main/cards/tags-service';
import { CardSessionManager } from '../../../src/main/cards/session';
import { apiByName } from '../../../src/main/cards/api-registry';
import type { CardPermissions } from '../../../src/main/cards/permissions';
import type { TagReading } from '../../../src/shared/tag-reading';

/**
 * 读侧 API 与**权限过滤**。
 *
 * ── 这是整个产品最要紧的一段代码 ──
 *
 * 卡片是 AI 写的任意网页，它能调用 `cockpit.*`。
 * 权限过滤**只在这一层**做（main 侧），页面与 bridge 都不判。
 *
 * ── 两条铁律 ──
 *
 * 1. **没权限的 tag 读不到**，而且**看不出它存不存在**
 *    （返回 `unavailable` + `not_found`，与「本来就没有」**一模一样**）
 *    ——否则卡片可以拿「读得到 / 读不到」当**探测通道**，把板子上的
 *    所有 tag 名一个一个试出来。
 * 2. **通配订阅每次推送都要再判一次**
 *    ——订阅时判一次不够：权限集是**建卡时**定的，
 *    但推送是**每次**发生的。
 */

function reading(tag: string, over: Partial<TagReading> = {}): TagReading {
  return {
    tag,
    value: 12.5,
    unit: 'percent',
    status: 'ok',
    at: 1,
    seq: 1,
    ...over,
  };
}

const READINGS: TagReading[] = [
  reading('cpu.usage', { value: 37.2 }),
  reading('cpu.core.3.usage', { value: 40 }),
  reading('mem.usage', { value: 62 }),
  reading('npu.usage', { status: 'unavailable', value: null, reason: 'device_absent' }),
];

function service(perms: CardPermissions): TagsService {
  return new TagsService(perms, {
    readings: () => READINGS,
    subscribe: () => () => undefined,
    now: () => 1000,
  });
}

describe('读侧 · 权限过滤', () => {
  it('有权限的 tag → 读得到真值', () => {
    const svc = service({ read: ['cpu.usage'], write: [] });
    expect(svc.get('cpu.usage').value).toBe(37.2);
    expect(svc.get('cpu.usage').status).toBe('ok');
  });

  it('**没权限的 tag → 读不到，而且看不出存不存在**', () => {
    const svc = service({ read: ['cpu.usage'], write: [] });
    const hidden = svc.get('mem.usage');
    expect(hidden.value).toBeNull();
    expect(hidden.status).toBe('unavailable');
    expect(hidden.reason).toBe('not_found');
  });

  it('本来就没有的 tag → **和没权限的长得一模一样**', () => {
    const svc = service({ read: ['cpu.usage'], write: [] });
    const missing = svc.get('nope.not.here');
    const hidden = svc.get('mem.usage');
    expect(missing.status).toBe(hidden.status);
    expect(missing.reason).toBe(hidden.reason);
  });

  it('list() 只给有权限的', () => {
    const svc = service({ read: ['cpu.usage'], write: [] });
    expect(svc.list().map((r) => r.tag)).toEqual(['cpu.usage']);
  });

  it('通配权限能覆盖具体的 tag', () => {
    const svc = service({ read: ['cpu.core.*.usage'], write: [] });
    expect(svc.get('cpu.core.3.usage').value).toBe(40);
  });

  it('订阅：没权限的**一个都不推**', () => {
    const svc = service({ read: ['cpu.usage'], write: [] });
    const seen: string[] = [];
    svc.subscribePattern('cpu.core.*.usage', (r) => seen.push(r.tag));
    expect(seen).toEqual([]);
  });

  it('订阅：有权限的按周期推', () => {
    const pushed: TagReading[] = [];
    const svc = new TagsService(
      { read: ['cpu.core.*.usage'], write: [] },
      {
        readings: () => READINGS,
        subscribe: (cb) => {
          // 立刻推一次（模拟一次变化）
          cb(reading('cpu.core.3.usage', { value: 41 }));
          return () => undefined;
        },
        now: () => 1000,
      },
    );
    svc.subscribePattern('cpu.core.*.usage', (r) => pushed.push(r));
    expect(pushed.map((r) => r.tag)).toEqual(['cpu.core.3.usage']);
  });

  it('降级信息：把 unavailable 的读数与原因列出来', () => {
    const svc = service({ read: ['cpu.usage', 'npu.usage'], write: [] });
    const degraded = svc.degradation();
    expect(degraded.length).toBeGreaterThan(0);
    expect(degraded.some((d) => d.tag === 'npu.usage')).toBe(true);
  });
});

describe('卡片会话 · 分发与鉴权', () => {
  function manager(perms: CardPermissions): CardSessionManager {
    return new CardSessionManager({
      runtime: {
        readings: () => READINGS,
        subscribe: () => () => undefined,
      } as unknown as ConstructorParameters<typeof CardSessionManager>[0]['runtime'],
      permsFor: () => perms,
      now: () => 1000,
    });
  }

  it('不认识的方法 → unknown_method', async () => {
    const m = manager({ read: ['cpu.usage'], write: [] });
    m.open('inst-1', 'cpu-usage', 'board-adb');
    const res = await m.handle({
      instanceId: 'inst-1',
      id: 'r1',
      method: 'no.such.method',
      args: {},
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unknown_method');
  });

  it('**M5 没有写侧** → actions.invoke 是 unknown_method（不是 denied）', async () => {
    const m = manager({ read: ['cpu.usage'], write: ['cpu.governor.set'] });
    m.open('inst-1', 'cpu-usage', 'board-adb');
    const res = await m.handle({
      instanceId: 'inst-1',
      id: 'r1',
      method: 'actions.invoke',
      args: { id: 'cpu.governor.set' },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unknown_method');
    expect(apiByName().has('actions.invoke')).toBe(false);
  });

  it('没权限的 tag → not_found（不泄露存在性）', async () => {
    const m = manager({ read: ['cpu.usage'], write: [] });
    m.open('inst-1', 'cpu-usage', 'board-adb');
    const res = await m.handle({
      instanceId: 'inst-1',
      id: 'r1',
      method: 'tags.get',
      args: { name: 'mem.usage' },
    });
    expect(res.ok).toBe(true);
    expect((res.value as TagReading).status).toBe('unavailable');
    expect((res.value as TagReading).reason).toBe('not_found');
  });

  it('有权限的 tag → 拿得到真值', async () => {
    const m = manager({ read: ['cpu.usage'], write: [] });
    m.open('inst-1', 'cpu-usage', 'board-adb');
    const res = await m.handle({
      instanceId: 'inst-1',
      id: 'r1',
      method: 'tags.get',
      args: { name: 'cpu.usage' },
    });
    expect(res.ok).toBe(true);
    expect((res.value as TagReading).value).toBe(37.2);
  });

  it('没登记的实例 → 拒绝（不猜）', async () => {
    const m = manager({ read: ['cpu.usage'], write: [] });
    const res = await m.handle({
      instanceId: 'nope',
      id: 'r1',
      method: 'tags.get',
      args: { name: 'cpu.usage' },
    });
    expect(res.ok).toBe(false);
  });
});

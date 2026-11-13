import { describe, it, expect } from 'vitest';
import { TagStore } from '../../src/main/tags/store';
import type { ReasonCode, TagStatus } from '../../src/shared/tag-reading';

/**
 * TagStore —— 读数的**唯一汇点**（ADR-D22）。
 *
 * 「驾驶舱」的产品底线是「UI 显示板子的真实状态」。
 * **一份状态有多个副本，就等于没有真相**——
 * 所以不管数据来自轮询还是将来的推送，进 TagStore 之后再分发。
 *
 * 五态迁移照抄契约 `docs/spec/01` §2.1 的那张表——
 * **不许各写各的**（契约原话：「这张表是**有状态的**：运行时必须按这张表迁移」）。
 */

function input(
  tag: string,
  value: number | string | boolean | null,
  status: TagStatus = 'ok',
  extra: { reason?: ReasonCode; detail?: string } = {},
) {
  return { tag, value, unit: 'percent', status, at: 1000, ...extra };
}

describe('写入与读出', () => {
  it('写进去能读出来', () => {
    const store = new TagStore();
    store.put(input('cpu.usage', 12.5));
    expect(store.get('cpu.usage')?.value).toBe(12.5);
  });

  it('读出来的是**同一个对象**（不是副本）', () => {
    const store = new TagStore();
    store.put(input('cpu.usage', 12.5));
    expect(store.get('cpu.usage')).toBe(store.get('cpu.usage'));
  });

  it('写进去的读数是**冻结的**（改了不会影响 store）', () => {
    const store = new TagStore();
    store.put(input('cpu.usage', 12.5));
    const got = store.get('cpu.usage')!;
    expect(Object.isFrozen(got)).toBe(true);
    expect(() => {
      (got as { value: unknown }).value = 99;
    }).toThrow();
    expect(store.get('cpu.usage')!.value).toBe(12.5);
  });

  it('没写过的 tag 读出来是 undefined', () => {
    expect(new TagStore().get('nosuch')).toBeUndefined();
  });

  it('all() 给出全部读数', () => {
    const store = new TagStore();
    store.put(input('a', 1));
    store.put(input('b', 2));
    expect(store.all().map((r) => r.tag).sort()).toEqual(['a', 'b']);
  });
});

describe('seq · 同一 tag 内单调递增', () => {
  it('同一个 tag 连续写入，seq 递增', () => {
    const store = new TagStore();
    const r1 = store.put(input('cpu.usage', 1));
    const r2 = store.put(input('cpu.usage', 2));
    expect(r2.seq).toBeGreaterThan(r1.seq);
  });

  it('不同 tag 的 seq **各自独立**', () => {
    const store = new TagStore();
    const a1 = store.put(input('a', 1));
    const b1 = store.put(input('b', 1));
    expect(a1.seq).toBe(b1.seq);
  });

  it('**乱序的旧值被丢弃**（渲染层拿到的是最新的那个）', () => {
    const store = new TagStore();
    const first = store.put(input('cpu.usage', 1));
    const second = store.put(input('cpu.usage', 2));
    // 拿一个更旧的 seq 来写：必须被丢掉
    const stale = store.put({ ...input('cpu.usage', 999), seq: first.seq } as never);
    expect(stale.seq).toBe(second.seq);
    expect(store.get('cpu.usage')!.value).toBe(2);
  });
});

describe('五态迁移 · 契约 §2.1', () => {
  it('ok → stale **保留旧值**', () => {
    const store = new TagStore();
    store.put(input('cpu.usage', 12.5));
    store.put(input('cpu.usage', 12.5, 'stale'));
    const got = store.get('cpu.usage')!;
    expect(got.status).toBe('stale');
    expect(got.value).toBe(12.5);
  });

  it('ok → unavailable **不保留**（值为 null）', () => {
    const store = new TagStore();
    store.put(input('cpu.usage', 12.5));
    store.put(input('cpu.usage', null, 'unavailable'));
    const got = store.get('cpu.usage')!;
    expect(got.status).toBe('unavailable');
    expect(got.value).toBeNull();
  });

  it('ok → error **保留旧值**（值坏了，不是没了）', () => {
    const store = new TagStore();
    store.put(input('cpu.usage', 12.5));
    store.put(input('cpu.usage', null, 'error'));
    const got = store.get('cpu.usage')!;
    expect(got.status).toBe('error');
    expect(got.value).toBe(12.5);
  });

  it('pending → error **没有旧值**（从没成功过）', () => {
    const store = new TagStore();
    store.put(input('cpu.usage', null, 'pending'));
    store.put(input('cpu.usage', null, 'error'));
    expect(store.get('cpu.usage')!.value).toBeNull();
  });

  it('unavailable → error 没有旧值', () => {
    const store = new TagStore();
    store.put(input('cpu.usage', null, 'unavailable'));
    store.put(input('cpu.usage', null, 'error'));
    expect(store.get('cpu.usage')!.value).toBeNull();
  });

  it('error → error **继续保留**上一次的值', () => {
    const store = new TagStore();
    store.put(input('cpu.usage', 12.5));
    store.put(input('cpu.usage', null, 'error'));
    store.put(input('cpu.usage', null, 'error'));
    expect(store.get('cpu.usage')!.value).toBe(12.5);
  });

  it('pending 的值是 null（**不是 0**）', () => {
    const store = new TagStore();
    store.put(input('cpu.usage', null, 'pending'));
    expect(store.get('cpu.usage')!.value).toBeNull();
  });

  it('unavailable 带着 reason 与 detail', () => {
    const store = new TagStore();
    store.put(input('cpu.usage', null, 'unavailable', {
      reason: 'device_absent',
      detail: '/sys/kernel/debug/rknpu/load 不存在：debugfs 未挂载',
    }));
    const got = store.get('cpu.usage')!;
    expect(got.reason).toBe('device_absent');
    expect(got.detail).toContain('debugfs');
  });

  it('ok 之后又 ok：值换新，seq 继续涨', () => {
    const store = new TagStore();
    const r1 = store.put(input('cpu.usage', 1));
    const r2 = store.put(input('cpu.usage', 2));
    expect(store.get('cpu.usage')!.value).toBe(2);
    expect(r2.seq).toBeGreaterThan(r1.seq);
  });
});

describe('分发 · ADR-D22「进 TagStore 之后再分发」', () => {
  it('写进一个读数就通知订阅者', () => {
    const store = new TagStore();
    const seen: string[] = [];
    store.subscribe((r) => seen.push(r.tag));
    store.put(input('cpu.usage', 1));
    expect(seen).toEqual(['cpu.usage']);
  });

  it('退订之后不再通知', () => {
    const store = new TagStore();
    const seen: string[] = [];
    const off = store.subscribe((r) => seen.push(r.tag));
    store.put(input('a', 1));
    off();
    store.put(input('b', 2));
    expect(seen).toEqual(['a']);
  });

  it('**乱序的旧值被丢掉时不通知**（别把旧值再发一遍）', () => {
    const store = new TagStore();
    const first = store.put(input('cpu.usage', 1));
    store.put(input('cpu.usage', 2));
    const seen: number[] = [];
    store.subscribe((r) => seen.push(r.seq));
    store.put({ ...input('cpu.usage', 999), seq: first.seq } as never);
    expect(seen).toEqual([]);
  });
});

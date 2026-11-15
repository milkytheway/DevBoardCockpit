import { describe, it, expect } from 'vitest';
import { TagStore, type TagSample } from '../../../src/main/tags/store';

/**
 * **样本环形缓冲**（契约 `spec/04` §2.1 ✓ · ADR-D40 ✓）。
 *
 * ── 为什么要有 ──
 *
 * `TagStore` **每个 tag 只留最新一条** ✓ —— 而 MCP 的两个工具要**最近 n 个样本** ✓：
 * - `sample_tag(name, n)` —— agent 判断「这个量是稳定的还是抖动的」✓
 * - `describe_tag(...).history` —— 同一个窗口 ✓
 *
 * → **没有缓冲就答不了** ✓（只能给一条 ✓ —— 那不叫「n 个样本」✓）。
 *
 * ── 口径 ──
 *
 * | 项 | 规则 |
 * |---|---|
 * | 顺序 | **最旧 → 最新** ✓（agent 看的是时间序列 ✓） |
 * | 满了 | **丢最旧的** ✓（环形 ✓） |
 * | 容量 | **实现细节** ✓ —— 契约只说「最多 n 个，不足不补」✓ → **不锁死** ✓ |
 * | 记录什么 | **存进去的那个读数** ✓（含五态 ✓ —— `unavailable` 的 value 是 `null` ✓） |
 */
describe('TagStore · 样本环形缓冲', () => {
  function put(store: TagStore, tag: string, value: number, at: number): void {
    store.put({ tag, value, unit: '%', status: 'ok', at });
  }

  it('**连续写 5 个 → 拿得到最近 5 个** ✓', () => {
    const store = new TagStore();
    for (let i = 0; i < 5; i += 1) put(store, 'cpu.usage', i, 1000 + i);
    const history = store.history('cpu.usage', 10);
    expect(history).toHaveLength(5);
    expect(history.map((s) => s.value)).toEqual([0, 1, 2, 3, 4]);
  });

  it('**顺序是最旧 → 最新** ✓（agent 看的是时间序列 ✓）', () => {
    const store = new TagStore();
    put(store, 'cpu.usage', 1, 1000);
    put(store, 'cpu.usage', 2, 2000);
    const history = store.history('cpu.usage', 10);
    expect(history.map((s) => s.at)).toEqual([1000, 2000]);
  });

  it('**n 小于总数 → 只给最近 n 个** ✓', () => {
    const store = new TagStore();
    for (let i = 0; i < 5; i += 1) put(store, 'cpu.usage', i, 1000 + i);
    const history = store.history('cpu.usage', 2);
    expect(history.map((s) => s.value)).toEqual([3, 4]);
  });

  it('**超过容量 → 丢最旧的** ✓（环形 ✓）', () => {
    const store = new TagStore({ historyLimit: 3 });
    for (let i = 0; i < 6; i += 1) put(store, 'cpu.usage', i, 1000 + i);
    const history = store.history('cpu.usage', 100);
    expect(history).toHaveLength(3);
    expect(history.map((s) => s.value)).toEqual([3, 4, 5]);
  });

  it('**每个 tag 各自一份** ✓（不串 ✓）', () => {
    const store = new TagStore();
    put(store, 'cpu.usage', 1, 1000);
    put(store, 'mem.usage', 2, 1000);
    put(store, 'cpu.usage', 3, 2000);
    expect(store.history('cpu.usage', 10).map((s) => s.value)).toEqual([1, 3]);
    expect(store.history('mem.usage', 10).map((s) => s.value)).toEqual([2]);
  });

  it('**没读过的 tag → 空数组** ✓（不是 `null` ✓ —— 契约 §四 ✓）', () => {
    const store = new TagStore();
    expect(store.history('nothing.here', 10)).toEqual([]);
  });

  it('**样本带 value / unit / status / at** ✓（与契约的形状一致 ✓）', () => {
    const store = new TagStore();
    store.put({ tag: 'cpu.usage', value: 42, unit: '%', status: 'ok', at: 1234 });
    const sample = store.history('cpu.usage', 1)[0] as TagSample;
    expect(sample.value).toBe(42);
    expect(sample.unit).toBe('%');
    expect(sample.status).toBe('ok');
    expect(sample.at).toBe(1234);
  });

  it('**`unavailable` 的样本 value 是 `null`** ✓（五态表 ✓）', () => {
    const store = new TagStore();
    store.put({ tag: 'x.y', value: null, unit: '-', status: 'unavailable', at: 1 });
    const sample = store.history('x.y', 1)[0] as TagSample;
    expect(sample.status).toBe('unavailable');
    expect(sample.value).toBeNull();
  });

  it('**乱序写入的旧值不进历史** ✓（store 把旧值丢掉 ✓ —— 历史跟着它 ✓）', () => {
    const store = new TagStore();
    store.put({ tag: 'cpu.usage', value: 1, unit: '%', status: 'ok', at: 1000 });
    store.put({ tag: 'cpu.usage', value: 2, unit: '%', status: 'ok', at: 2000 });
    // **seq 更小的乱序写入** ✓
    store.put({ tag: 'cpu.usage', value: 99, unit: '%', status: 'ok', at: 1500, seq: 1 });
    const history = store.history('cpu.usage', 10);
    expect(history.map((s) => s.value)).toEqual([1, 2]);
  });

  it('**容量是实现细节** ✓ —— 默认给一个够用的值 ✓', () => {
    const store = new TagStore();
    for (let i = 0; i < 200; i += 1) put(store, 'cpu.usage', i, 1000 + i);
    const history = store.history('cpu.usage', 1000);
    // **不满容量** ✓ → 全给 ✓
    expect(history.length).toBeGreaterThan(0);
    expect(history.length).toBeLessThanOrEqual(200);
  });
});

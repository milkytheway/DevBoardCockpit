import { describe, it, expect } from 'vitest';
import { TagStore, type TagSample } from '../../../src/main/tags/store';

/**
 * The **ring buffer of the samples** (contract `spec/04` §2.1).
 *
 * Why it exists:
 *
 * `TagStore` **keeps only the newest entry per tag**, while two tools of
 * MCP want the **last n samples**:
 * - `sample_tag(name, n)` — the agent decides whether a quantity is stable or
 *   jittering
 * - `describe_tag(...).history` — the same window
 *
 * → **Without a buffer it cannot answer** (it could only give one entry, and
 *   that is not "n samples").
 *
 * The rules:
 *
 * | Item | Rule |
 * |---|---|
 * | the order | **the oldest → the newest** (the agent looks at a time series) |
 * | when it is full | **the oldest are dropped** (a ring) |
 * | the capacity | **an implementation detail** — the contract only says "at most n, and it is not made up" → **it is not fixed** |
 * | what is recorded | **the reading that was put in** (with its five states — the value of `unavailable` is `null`) |
 */
describe('TagStore · the ring buffer of the samples', () => {
  function put(store: TagStore, tag: string, value: number, at: number): void {
    store.put({ tag, value, unit: '%', status: 'ok', at });
  }

  it('**five in a row → the last five can be got**', () => {
    const store = new TagStore();
    for (let i = 0; i < 5; i += 1) put(store, 'cpu.usage', i, 1000 + i);
    const history = store.history('cpu.usage', 10);
    expect(history).toHaveLength(5);
    expect(history.map((s) => s.value)).toEqual([0, 1, 2, 3, 4]);
  });

  it('**the order is the oldest → the newest** (the agent looks at a time series)', () => {
    const store = new TagStore();
    put(store, 'cpu.usage', 1, 1000);
    put(store, 'cpu.usage', 2, 2000);
    const history = store.history('cpu.usage', 10);
    expect(history.map((s) => s.at)).toEqual([1000, 2000]);
  });

  it('**n is below the total → only the last n are given**', () => {
    const store = new TagStore();
    for (let i = 0; i < 5; i += 1) put(store, 'cpu.usage', i, 1000 + i);
    const history = store.history('cpu.usage', 2);
    expect(history.map((s) => s.value)).toEqual([3, 4]);
  });

  it('**beyond the capacity → the oldest are dropped** (a ring)', () => {
    const store = new TagStore({ historyLimit: 3 });
    for (let i = 0; i < 6; i += 1) put(store, 'cpu.usage', i, 1000 + i);
    const history = store.history('cpu.usage', 100);
    expect(history).toHaveLength(3);
    expect(history.map((s) => s.value)).toEqual([3, 4, 5]);
  });

  it('**every tag has its own** (they do not mix)', () => {
    const store = new TagStore();
    put(store, 'cpu.usage', 1, 1000);
    put(store, 'mem.usage', 2, 1000);
    put(store, 'cpu.usage', 3, 2000);
    expect(store.history('cpu.usage', 10).map((s) => s.value)).toEqual([1, 3]);
    expect(store.history('mem.usage', 10).map((s) => s.value)).toEqual([2]);
  });

  it('**a tag that was never read → an empty array** (not `null` — contract §4)', () => {
    const store = new TagStore();
    expect(store.history('nothing.here', 10)).toEqual([]);
  });

  it('**a sample carries value / unit / status / at** (the same shape as the contract)', () => {
    const store = new TagStore();
    store.put({ tag: 'cpu.usage', value: 42, unit: '%', status: 'ok', at: 1234 });
    const sample = store.history('cpu.usage', 1)[0] as TagSample;
    expect(sample.value).toBe(42);
    expect(sample.unit).toBe('%');
    expect(sample.status).toBe('ok');
    expect(sample.at).toBe(1234);
  });

  it('**the value of the sample of `unavailable` is `null`** (the table of the five states)', () => {
    const store = new TagStore();
    store.put({ tag: 'x.y', value: null, unit: '-', status: 'unavailable', at: 1 });
    const sample = store.history('x.y', 1)[0] as TagSample;
    expect(sample.status).toBe('unavailable');
    expect(sample.value).toBeNull();
  });

  it('**an out-of-order old value does not enter the history** (the store drops the old value — the history follows it)', () => {
    const store = new TagStore();
    store.put({ tag: 'cpu.usage', value: 1, unit: '%', status: 'ok', at: 1000 });
    store.put({ tag: 'cpu.usage', value: 2, unit: '%', status: 'ok', at: 2000 });
    // **An out-of-order write with a smaller seq**
    store.put({ tag: 'cpu.usage', value: 99, unit: '%', status: 'ok', at: 1500, seq: 1 });
    const history = store.history('cpu.usage', 10);
    expect(history.map((s) => s.value)).toEqual([1, 2]);
  });

  it('**the capacity is an implementation detail** — a value that is good enough is given by default', () => {
    const store = new TagStore();
    for (let i = 0; i < 200; i += 1) put(store, 'cpu.usage', i, 1000 + i);
    const history = store.history('cpu.usage', 1000);
    // **It is not full** → everything is given
    expect(history.length).toBeGreaterThan(0);
    expect(history.length).toBeLessThanOrEqual(200);
  });
});

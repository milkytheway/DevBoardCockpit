import { describe, it, expect } from 'vitest';
import { TagStore } from '../../src/main/tags/store';
import { REASON_CODES, type ReasonCode, type TagStatus } from '../../src/shared/tag-reading';

/**
 * TagStore — the **single meeting point** of the readings (ADR-D22).
 *
 * The product bottom line of a "cockpit" is that the interface shows the real
 * state of the board. **Several copies of one state mean there is no truth at
 * all**, so whether the data comes from polling or from a push later, the
 * dispatch happens after it entered the TagStore.
 *
 * The migration of the five states follows the table of contract
 * `docs/spec/01` §2.1 — **nobody may write their own** (the words of the
 * contract: "this table is **stateful**: the runtime has to migrate along
 * this table").
 */

function input(
  tag: string,
  value: number | string | boolean | null,
  status: TagStatus = 'ok',
  extra: { reason?: ReasonCode; detail?: string } = {},
) {
  return { tag, value, unit: 'percent', status, at: 1000, ...extra };
}

describe('the table of reason codes · closed and minimal (contract §2.1.1)', () => {
  it('**exactly seven** — the table stays minimal, the detail carries the specificity', () => {
    expect([...REASON_CODES]).toEqual([
      'not_found',
      'device_absent',
      'service_down',
      'link_busy_terminal',
      'parse_error',
      'out_of_domain',
      'timeout',
    ]);
  });

  it('**there is no not_in_pack** — it was merged into not_found (O14 of ADR-D27)', () => {
    // "the thing you asked for does not exist" has the same name on the reading
// and the writing side —
    // **No two dialects for an AI that would have to be translated into each
// other**.
    expect(REASON_CODES).not.toContain('not_in_pack');
  });
});

describe('writing and reading', () => {
  it('what was written can be read back', () => {
    const store = new TagStore();
    store.put(input('cpu.usage', 12.5));
    expect(store.get('cpu.usage')?.value).toBe(12.5);
  });

  it('what is read back is **the same object** (not a copy)', () => {
    const store = new TagStore();
    store.put(input('cpu.usage', 12.5));
    expect(store.get('cpu.usage')).toBe(store.get('cpu.usage'));
  });

  it('the reading that was written is **frozen** (changing it does not affect the store)', () => {
    const store = new TagStore();
    store.put(input('cpu.usage', 12.5));
    const got = store.get('cpu.usage')!;
    expect(Object.isFrozen(got)).toBe(true);
    expect(() => {
      (got as { value: unknown }).value = 99;
    }).toThrow();
    expect(store.get('cpu.usage')!.value).toBe(12.5);
  });

  it('a tag that was never written reads back as undefined', () => {
    expect(new TagStore().get('nosuch')).toBeUndefined();
  });

  it('all() gives every reading', () => {
    const store = new TagStore();
    store.put(input('a', 1));
    store.put(input('b', 2));
    expect(store.all().map((r) => r.tag).sort()).toEqual(['a', 'b']);
  });
});

describe('seq · it increases monotonically within one tag', () => {
  it('writing the same tag in a row, the seq increases', () => {
    const store = new TagStore();
    const r1 = store.put(input('cpu.usage', 1));
    const r2 = store.put(input('cpu.usage', 2));
    expect(r2.seq).toBeGreaterThan(r1.seq);
  });

  it('the seq of different tags is **independent**', () => {
    const store = new TagStore();
    const a1 = store.put(input('a', 1));
    const b1 = store.put(input('b', 1));
    expect(a1.seq).toBe(b1.seq);
  });

  it('**an out-of-order old value is dropped** (the rendering layer gets the newest one)', () => {
    const store = new TagStore();
    const first = store.put(input('cpu.usage', 1));
    const second = store.put(input('cpu.usage', 2));
    // Writing with an older seq: it has to be dropped
    const stale = store.put({ ...input('cpu.usage', 999), seq: first.seq } as never);
    expect(stale.seq).toBe(second.seq);
    expect(store.get('cpu.usage')!.value).toBe(2);
  });
});

describe('the migration of the five states · contract §2.1', () => {
  it('ok → stale **keeps the old value**', () => {
    const store = new TagStore();
    store.put(input('cpu.usage', 12.5));
    store.put(input('cpu.usage', 12.5, 'stale'));
    const got = store.get('cpu.usage')!;
    expect(got.status).toBe('stale');
    expect(got.value).toBe(12.5);
  });

  it('ok → unavailable **does not keep it** (the value is null)', () => {
    const store = new TagStore();
    store.put(input('cpu.usage', 12.5));
    store.put(input('cpu.usage', null, 'unavailable'));
    const got = store.get('cpu.usage')!;
    expect(got.status).toBe('unavailable');
    expect(got.value).toBeNull();
  });

  it('ok → error **keeps the old value** (the value is broken, not gone)', () => {
    const store = new TagStore();
    store.put(input('cpu.usage', 12.5));
    store.put(input('cpu.usage', null, 'error'));
    const got = store.get('cpu.usage')!;
    expect(got.status).toBe('error');
    expect(got.value).toBe(12.5);
  });

  it('pending → error **has no old value** (it never succeeded)', () => {
    const store = new TagStore();
    store.put(input('cpu.usage', null, 'pending'));
    store.put(input('cpu.usage', null, 'error'));
    expect(store.get('cpu.usage')!.value).toBeNull();
  });

  it('unavailable → error has no old value', () => {
    const store = new TagStore();
    store.put(input('cpu.usage', null, 'unavailable'));
    store.put(input('cpu.usage', null, 'error'));
    expect(store.get('cpu.usage')!.value).toBeNull();
  });

  it('error → error **keeps** the value of the last time', () => {
    const store = new TagStore();
    store.put(input('cpu.usage', 12.5));
    store.put(input('cpu.usage', null, 'error'));
    store.put(input('cpu.usage', null, 'error'));
    expect(store.get('cpu.usage')!.value).toBe(12.5);
  });

  it('the value of pending is null (**not 0**)', () => {
    const store = new TagStore();
    store.put(input('cpu.usage', null, 'pending'));
    expect(store.get('cpu.usage')!.value).toBeNull();
  });

  it('unavailable carries the reason and the detail', () => {
    const store = new TagStore();
    store.put(input('cpu.usage', null, 'unavailable', {
      reason: 'device_absent',
      detail: '/sys/kernel/debug/rknpu/load does not exist: debugfs is not mounted',
    }));
    const got = store.get('cpu.usage')!;
    expect(got.reason).toBe('device_absent');
    expect(got.detail).toContain('debugfs');
  });

  it('ok and then ok again: the value is new, the seq keeps growing', () => {
    const store = new TagStore();
    const r1 = store.put(input('cpu.usage', 1));
    const r2 = store.put(input('cpu.usage', 2));
    expect(store.get('cpu.usage')!.value).toBe(2);
    expect(r2.seq).toBeGreaterThan(r1.seq);
  });
});

describe('the dispatch · the dispatch happens after the TagStore (ADR-D22)', () => {
  it('writing a reading notifies the subscribers', () => {
    const store = new TagStore();
    const seen: string[] = [];
    store.subscribe((r) => seen.push(r.tag));
    store.put(input('cpu.usage', 1));
    expect(seen).toEqual(['cpu.usage']);
  });

  it('after the unsubscription there is no more notification', () => {
    const store = new TagStore();
    const seen: string[] = [];
    const off = store.subscribe((r) => seen.push(r.tag));
    store.put(input('a', 1));
    off();
    store.put(input('b', 2));
    expect(seen).toEqual(['a']);
  });

  it('**an out-of-order old value that was dropped notifies nothing** (the old value must not be sent again)', () => {
    const store = new TagStore();
    const first = store.put(input('cpu.usage', 1));
    store.put(input('cpu.usage', 2));
    const seen: number[] = [];
    store.subscribe((r) => seen.push(r.seq));
    store.put({ ...input('cpu.usage', 999), seq: first.seq } as never);
    expect(seen).toEqual([]);
  });
});

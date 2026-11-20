import { describe, it, expect } from 'vitest';
import {
  cardState,
  missingTags,
  unreadableTags,
  patternCovered,
} from '../../../src/main/cards/state';
import type { CardManifest } from '../../../src/main/cards/manifest';
import type { PackView } from '../../../src/main/tags/pack-view';
import type { TagReading } from '../../../src/shared/tag-reading';

/**
 * The state of a card on the current board (contract `spec/04` §2.2).
 *
 * The core this group of criteria protects:
 *
 * | Criterion | Why |
 * |---|---|
 * | `missing_tags` and `unreadable_tags` are **kept apart** | mixed together → **the agent is misled** |
 * | **a wildcard instance absent from the readings does not count as missing** | the sampler **does not guess the concrete instance names** |
 * | an `invalid` card is **still listed** | the agent has to know that "the card I installed last time is broken" |
 * | `installed_at` is the **mtime of the directory** | the host **never recorded an installation time** |
 */

const MANIFEST: CardManifest = {
  apiVersion: 'devboard/v1',
  kind: 'Card',
  id: 'demo',
  name: 'demo card',
  version: '1.0.0',
  entry: 'index.html',
  permissions: { read: ['cpu.usage', 'mem.usage'], write: [] },
};

const PACK: PackView = {
  id: 'demo-pack',
  name: 'demo pack',
  version: '1.0.0',
  poll_groups: [],
  readers: [
    {
      id: 'cpu',
      kind: 'proc_stat',
      args: {},
      provides: ['cpu.usage'],
      poll_group: 'fast',
      interval_ms: 1000,
    },
    {
      id: 'mem',
      kind: 'meminfo',
      args: {},
      provides: ['mem.usage'],
      poll_group: 'fast',
      interval_ms: 1000,
    },
  ],
  actions: [],
};

function reading(tag: string, status: TagReading['status'], value: number | null = 1): TagReading {
  return { tag, value, unit: '%', status, at: 1000, seq: 1 };
}

describe('card state · the pattern shadowing decision', () => {
  it('**the wildcard side shadows the literal side**', () => {
    expect(patternCovered('cpu.*.usage', 'cpu.core.usage')).toBe(true);
    expect(patternCovered('cpu.core.usage', 'cpu.core.usage')).toBe(true);
  });

  it('**a different number of segments → no shadowing**', () => {
    expect(patternCovered('cpu.core.*.usage', 'cpu.usage')).toBe(false);
  });

  it('**a different literal → no shadowing**', () => {
    expect(patternCovered('cpu.usage', 'mem.usage')).toBe(false);
  });
});

describe('card state · missing_tags (the board does not have them at all)', () => {
  it('**the pack has it → it does not count as missing**', () => {
    expect(missingTags(MANIFEST, PACK)).toEqual([]);
  });

  it('**the pack does not have it → it is recorded** (the pattern itself is recorded)', () => {
    const manifest: CardManifest = {
      ...MANIFEST,
      permissions: { read: ['cpu.usage', 'npu.usage'], write: [] },
    };
    expect(missingTags(manifest, PACK)).toEqual(['npu.usage']);
  });

  it('**a wildcard read permission → the pack provides it → it does not count as missing**', () => {
    const manifest: CardManifest = {
      ...MANIFEST,
      permissions: { read: ['cpu.core.*.usage'], write: [] },
    };
    const pack: PackView = {
      ...PACK,
      readers: [{ ...(PACK.readers[0] as PackView['readers'][number]), provides: ['cpu.core.*.usage'] }],
    };
    expect(missingTags(manifest, pack)).toEqual([]);
  });

  it('**no pack → "not on the board at all" is not decided** (that is "not known yet", not "absent")', () => {
    expect(missingTags(MANIFEST, null)).toEqual([]);
  });
});

describe('card state · unreadable_tags (they cannot be read right now)', () => {
  it('**the status is not ok → it is recorded**', () => {
    const readings = [reading('cpu.usage', 'error', null), reading('mem.usage', 'ok')];
    expect(unreadableTags(MANIFEST, PACK, readings)).toEqual(['cpu.usage']);
  });

  it('**this card does not read it → it is not recorded**', () => {
    const readings = [reading('gpu.usage', 'error', null)];
    expect(unreadableTags(MANIFEST, PACK, readings)).toEqual([]);
  });

  it('**a wildcard instance is absent from the readings → it is not listed** (that means "not on the board / not sampled yet")', () => {
    const manifest: CardManifest = {
      ...MANIFEST,
      permissions: { read: ['cpu.core.*.usage'], write: [] },
    };
    // **the readings hold only cpu.core.0.usage (ok)** — cpu.core.7.usage is **not**
// among them
    const readings = [reading('cpu.core.0.usage', 'ok')];
    expect(unreadableTags(manifest, PACK, readings)).toEqual([]);
  });

  it('**stale counts as "cannot be read"** (an old value is not the same as reading it now)', () => {
    const readings = [reading('cpu.usage', 'stale', 5)];
    expect(unreadableTags(MANIFEST, PACK, readings)).toEqual(['cpu.usage']);
  });
});

describe('card state · as a whole', () => {
  const base = {
    cardId: 'demo',
    dir: '/tmp/cards/demo',
    manifest: MANIFEST,
    issues: [],
    pack: PACK,
    readings: [] as TagReading[],
  };

  it('**clean → `ok`**', () => {
    const state = cardState(base);
    expect(state.status).toBe('ok');
    expect(state.degraded).toBe(false);
    expect(state.missing_tags).toEqual([]);
    expect(state.unreadable_tags).toEqual([]);
  });

  it('**a tag cannot be read → `degraded`**', () => {
    const state = cardState({ ...base, readings: [reading('mem.usage', 'error', null)] });
    expect(state.status).toBe('degraded');
    expect(state.degraded).toBe(true);
    expect(state.unreadable_tags).toEqual(['mem.usage']);
  });

  it('**the manifest is invalid → `invalid`** (**it is still listed**)', () => {
    const state = cardState({ ...base, issues: [{ severity: 'error' }] });
    expect(state.status).toBe('invalid');
    expect(state.id).toBe('demo');
  });

  it('**warnings only → `degraded`**', () => {
    const state = cardState({ ...base, issues: [{ severity: 'warning' }] });
    expect(state.status).toBe('degraded');
  });

  it('**`id` is the directory name, `manifest_id` is the one the manifest declares** (the two may differ)', () => {
    const state = cardState({ ...base, cardId: 'demo-dir', manifest: { ...MANIFEST, id: 'demo' } });
    expect(state.id).toBe('demo-dir');
    expect(state.manifest_id).toBe('demo');
  });

  it('**`path` is an absolute path**', () => {
    expect(cardState(base).path).toBe('/tmp/cards/demo');
  });

  it('**`installed_at` is the mtime of the directory** (**not** the moment of installation)', () => {
    // **the directory does not exist → 0** (it does not guess)
    expect(cardState(base).installed_at).toBe(0);
  });
});

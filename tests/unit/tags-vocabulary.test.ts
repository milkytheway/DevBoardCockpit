import { describe, it, expect } from 'vitest';
import {
  BOARD_CAPABILITIES,
  IMPLEMENTED_CAPABILITIES,
  isBoardCapability,
  isImplementedCapability,
  matchTagPattern,
  isCoreTag,
  isCustomTag,
} from '../../src/main/tags/vocabulary';

/**
 * The capability vocabulary and the pattern matching of a tag.
 *
 * **The two vocabularies are two axes** (contract §10.3):
 * - board level `{shell, exec, stream, files}` — "what this board can do"
 * - connection level `{exec, pty, files, exitCode}` — "what **this connection**
 *   can do"
 *
 * The board-level vocabulary **has** `stream` (that is a real board-level
 * capability), but the **set of implemented capabilities does not have it**
 * (the contract of Stream is not written yet, so it cannot be offered even if
 * it is declared) — that is exactly the division of labour between rule 25
 * and rule 26.
 */

describe('the board-level capability vocabulary (the data of rule 25)', () => {
  it('the closed vocabulary is exactly these four', () => {
    expect([...BOARD_CAPABILITIES]).toEqual(['shell', 'exec', 'stream', 'files']);
  });

  it('stream is in the vocabulary (it is a real board-level capability)', () => {
    expect(isBoardCapability('stream')).toBe(true);
  });

  it('an unknown value is not in the vocabulary', () => {
    expect(isBoardCapability('shellh')).toBe(false);
    expect(isBoardCapability('SHELL')).toBe(false);
    expect(isBoardCapability('')).toBe(false);
  });
});

describe('the set of implemented capabilities (the data of rule 26)', () => {
  it('exactly shell / exec / files', () => {
    expect([...IMPLEMENTED_CAPABILITIES]).toEqual(['shell', 'exec', 'files']);
  });

  it('stream is not in the implemented set — it cannot be offered even if it is declared', () => {
    expect(isImplementedCapability('stream')).toBe(false);
  });

  it('the implemented set is a subset of the board-level vocabulary', () => {
    for (const c of IMPLEMENTED_CAPABILITIES) {
      expect(isBoardCapability(c)).toBe(true);
    }
  });

  it('**rule 26 reads a table, it is not a hard-coded if (stream)**', () => {
    // This assertion guards "when Stream lands, the table changes, not the rule".
    // In other words: the relation between the implemented set and the vocabulary
// is a **relation of sets**, not a few hard-coded names.
    // `new Set<string>`: `Set<"shell"|"exec"|"files">.has(c)` is
    // **strict** in TypeScript (c may be "stream") — without the type parameter it
// does not even compile.
    const implemented = new Set<string>(IMPLEMENTED_CAPABILITIES);
    for (const c of BOARD_CAPABILITIES) {
      expect(isImplementedCapability(c)).toBe(implemented.has(c));
    }
  });
});

describe('matchTagPattern · the pattern matching of a tag', () => {
  it('a wildcard segment matches a concrete one', () => {
    expect(matchTagPattern('cpu.core.*.usage', 'cpu.core.3.usage')).toBe(true);
  });

  it('a literal segment has to match position by position', () => {
    expect(matchTagPattern('cpu.core.*.usage', 'cpu.core.3.cluster')).toBe(false);
  });

  it('a different number of segments does not match', () => {
    expect(matchTagPattern('cpu.core.*.usage', 'cpu.usage')).toBe(false);
    expect(matchTagPattern('cpu.usage', 'cpu.usage.x')).toBe(false);
  });

  it('an exact equality matches', () => {
    expect(matchTagPattern('cpu.usage', 'cpu.usage')).toBe(true);
  });

  it('a wildcard segment may not match an empty one', () => {
    expect(matchTagPattern('cpu.core.*.usage', 'cpu.core..usage')).toBe(false);
  });

  it('one * takes one segment, not several', () => {
    expect(matchTagPattern('cpu.*.usage', 'cpu.core.3.usage')).toBe(false);
    expect(matchTagPattern('cpu.*.usage', 'cpu.3.usage')).toBe(true);
  });

  it('the sample side uses the same function (the premise of rule 7)', () => {
    // `core.*.usage` is a **sample** namespace, `cpu.core.*.usage` is a **tag**
// namespace
    // — two namespaces, but **the rule of the pattern is the same**.
    expect(matchTagPattern('core.*.usage', 'core.3.usage')).toBe(true);
    expect(matchTagPattern('core.*.usage', 'core.3.cluster')).toBe(false);
  });
});

describe('isCoreTag · a tag of the core vocabulary (the data of rule 1)', () => {
  it('the exact name of the vocabulary', () => {
    expect(isCoreTag('cpu.usage')).toBe(true);
    expect(isCoreTag('mem.total_bytes')).toBe(true);
  });

  it('a name expanded from a pattern of the vocabulary', () => {
    expect(isCoreTag('cpu.core.3.usage')).toBe(true);
  });

  it('a name that is not in the vocabulary', () => {
    expect(isCoreTag('cpu.temperature')).toBe(false);
  });

  it('the custom namespace is **not** the core vocabulary', () => {
    expect(isCoreTag('custom.rk3588-atk.npu.duty')).toBe(false);
  });
});

describe('isCustomTag · the custom namespace (rule 1)', () => {
  it('it belongs to the custom namespace of this pack', () => {
    expect(isCustomTag('custom.rk3588-atk.npu.duty', 'rk3588-atk')).toBe(true);
  });

  it('it belongs to the custom namespace of **another** pack', () => {
    expect(isCustomTag('custom.rk3568.npu.duty', 'rk3588-atk')).toBe(false);
  });

  it('a name of the core vocabulary is not custom', () => {
    expect(isCustomTag('cpu.usage', 'rk3588-atk')).toBe(false);
  });

  it('one without the custom prefix does not count', () => {
    expect(isCustomTag('rk3588-atk.npu.duty', 'rk3588-atk')).toBe(false);
  });
});

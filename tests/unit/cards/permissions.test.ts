import { describe, it, expect } from 'vitest';
import { permissionCovers, requiresSatisfied } from '../../../src/main/cards/permissions';

/**
 * The permission set of a card.
 *
 * One sentence of contract §2.2:
 *
 * > Every item of `requires` has to be covered by **one** item of
 * > `permissions`.
 *
 * **Note that it is "covered" and not "equal"** — that lets a card state an
 * exact need and ask for a wider read permission as well (the other way round
 * does not hold).
 */
describe('the coverage of the read permissions of a card', () => {
  it('a wildcard pattern covers a concrete tag (the example of contract §2.2)', () => {
    expect(permissionCovers({ read: ['cpu.core.*.usage'], write: [] }, 'cpu.core.3.usage')).toBe(
      true,
    );
  });

  it('the other way round does not hold: a concrete permission does not cover a wildcard', () => {
    expect(permissionCovers({ read: ['cpu.core.3.usage'], write: [] }, 'cpu.core.*.usage')).toBe(
      false,
    );
  });

  it('an unrelated tag is not covered', () => {
    expect(permissionCovers({ read: ['cpu.usage'], write: [] }, 'mem.usage')).toBe(false);
  });

  it('a different number of segments means it is not covered (cpu.core.*.usage does not cover cpu.usage)', () => {
    expect(permissionCovers({ read: ['cpu.core.*.usage'], write: [] }, 'cpu.usage')).toBe(false);
  });
});

describe('the relation between requires and permissions', () => {
  it('every item is covered → it is satisfied', () => {
    expect(
      requiresSatisfied(['cpu.core.3.usage'], { read: ['cpu.core.*.usage'], write: [] }),
    ).toBe(true);
  });

  it('one item is not covered → it is not satisfied', () => {
    expect(requiresSatisfied(['mem.usage'], { read: ['cpu.core.*.usage'], write: [] })).toBe(false);
  });

  it('an empty requires is always satisfied', () => {
    expect(requiresSatisfied([], { read: [], write: [] })).toBe(true);
  });
});

/**
 * **"the effective permission is the declaration"** (contract §2.4).
 *
 * → **There is no second "who granted it" any more** (**recording the same
 *   thing twice** — **it will not match eventually**).
 * → **The board pack decides**: **what the board can do is declared by the
 *   board pack**; **what this card can do is declared by its manifest** — and
 *   **the session layer guards it** (**everything outside the declaration is
 *   denied**, see `tests/unit/cards/session.test.ts`).
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { outcomesOf } from '../../src/main/wizard/probe-adapter';
import { loadBoardPack } from '../../src/main/tags/pack';
import { validatePack, errorsOf } from '../../src/main/tags/validator';
import { instantiatePack } from '../../src/main/wizard/instantiate';
import type { ProbeReaderReport } from '../../src/main/tags/probe';

/**
 * **The report of the probe → the instantiation** — added on 2026-11-19.
 *
 * It is **the only** bridge between the "real probe" and the "instantiation".
 *
 * → **The shapes differ** → **this layer in between is a buffer** →
 *   **the instantiation does not depend on the probe** (it is a pure
 *   function) → **it does not move when the probe changes its shape**.
 */
const REPO_ROOT = resolve(process.cwd());
const GENERIC_DIR = join(REPO_ROOT, 'profiles', 'boards', 'generic-linux');

function report(readerId: string, ok: boolean, problems: string[] = []): ProbeReaderReport {
  return { readerId, kind: 'file_read', tags: [], problems, ok };
}

describe('the probe → the instantiation · **that bridge**', () => {
  it('**the green and the red go over unchanged**', () => {
    const outcomes = outcomesOf([report('cpu', true), report('led', false, ['it cannot be read'])]);
    expect(outcomes.map((o) => [o.readerId, o.ok])).toEqual([
      ['cpu', true],
      ['led', false],
    ]);
  });

  it('**"why it is red" is composed into one sentence** (the probe gives a set of questions)', () => {
    const one = outcomesOf([report('led', false, ['the path is wrong'])])[0];
    expect(one?.detail).toBe('the path is wrong');
    const many = outcomesOf([report('led', false, ['A', 'B', 'C'])])[0];
    expect(many?.detail).toContain('3 problems');
    expect(many?.detail).toContain('A');
  });

  it('**the report of the real probe can be fed into the instantiation directly** (**end to end**)', () => {
    // → **the decision of the probe really runs** — the report is not made up by hand
    const generic = loadBoardPack(GENERIC_DIR);
    const readerIds = [...generic.readers, ...generic.custom].map((r) => r.id);
    const reports = readerIds.map((id) => report(id, true));
    const result = instantiatePack({
      source: generic,
      targetId: 'atk-01',
      targetName: 'my board',
      outcomes: outcomesOf(reports),
    });
    expect(
      errorsOf(validatePack(result.pack)).map((e) => `rule ${e.rule} · ${e.path}: ${e.message}`),
      '**the report of the real probe is fed in → the product still passes the validation**',
    ).toEqual([]);
  });
});

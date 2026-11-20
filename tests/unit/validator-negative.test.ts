import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBoardPack } from '../../src/main/tags/pack';
import { validatePack, errorsOf } from '../../src/main/tags/validator';
import { checkFloor } from '../../src/main/actions/floor-check';

/**
 * The negative vector of the danger floor.
 *
 * The sample `fixtures/validator/illegal-floor-downgrade.yaml` declares a
 * command that hits the danger floor as `danger: reversible`. The floor is a
 * lower bound: the validator has to refuse the pack at install time, and the
 * runtime has to classify the action as destructive even if the pack is
 * forced past the validator.
 *
 * Two assertions, and both are needed: with only the static check, a path
 * that bypasses the validator would run a reboot as if it were reversible.
 */

const REPO = join(__dirname, '../..');
const SAMPLE = join(REPO, 'fixtures/validator/illegal-floor-downgrade.yaml');

function loadSample() {
  const text = readFileSync(SAMPLE, 'utf8');
  return parseBoardPack(text, SAMPLE);
}

describe('the negative vector of the danger floor', () => {
  it('is rejected by the validator at rule 16, and only there', () => {
    const errors = errorsOf(validatePack(loadSample()));

    expect(errors).toHaveLength(1);
    expect(errors[0].rule).toBe(16);
    expect(errors[0].path).toBe('actions[0].command');
    expect(errors[0].message).toContain('danger floor');
  });

  it('is classified as destructive by the runtime, which is the backstop', () => {
    const verdict = checkFloor('reboot');

    expect(verdict.verdict).toBe('destructive');
    expect(verdict.matched).toBe(true);
  });
});
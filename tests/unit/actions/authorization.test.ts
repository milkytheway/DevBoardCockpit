import { describe, it, expect } from 'vitest';
import { authorize, type GrantedActions } from '../../../src/main/actions/authorization';
import type { ActionDef } from '../../../src/main/tags/schema';

/**
 * Authorisation — contract `docs/spec/02-board-pack.md` §5.5 + `spec/04` §2.4.1.
 *
 * There are exactly two criteria:
 *
 * | Case | Outcome |
 * |---|---|
 * | the action is **in the granted set** and the params are **inside the `guard` range** | **run directly** (still audited) |
 * | the action is **not granted** | **denied** |
 * | the params are **outside the `guard` range** | **denied** (never "ask the operator") |
 * | `destructive` | **run directly** (the danger level is informational — the gate is the permission area in the settings) |
 *
 * There is no third outcome: the `needs_confirmation` verdict was removed.
 */
const ACTION: ActionDef = {
  id: 'backlight.set',
  label: 'set backlight',
  danger: 'reversible',
  params: { value: { type: 'integer', min: 0, max: 255 } },
  guard: { value: { min: 16, max: 255 } },
  command: 'echo {value} > /sys/class/backlight/backlight/brightness',
  readback: { kind: 'file_equals', path: '/sys/class/backlight/backlight/brightness', expect: '{value}' },
};

const GRANTED: GrantedActions = {
  actions: { 'backlight.set': { value: { min: 16, max: 255 } } },
};

describe('authorisation · two criteria', () => {
  it('reversible + inside the range + granted → ok (runs directly)', () => {
    const result = authorize(ACTION, { value: 100 }, GRANTED);
    expect(result.verdict).toBe('ok');
  });

  it('the action is **not granted** → denied', () => {
    const result = authorize(ACTION, { value: 100 }, { actions: {} });
    expect(result.verdict).toBe('denied');
  });

  it('destructive → ok (**runs directly**, no prompt — the danger level is informational)', () => {
    const destructive: ActionDef = { ...ACTION, danger: 'destructive' };
    const result = authorize(destructive, { value: 100 }, GRANTED);
    expect(result.verdict).toBe('ok');
  });

  it('reversible but the param is **outside the guard** → denied (never "ask the operator")', () => {
    const result = authorize(ACTION, { value: 5 }, GRANTED);
    expect(result.verdict).toBe('denied');
  });

  it('the **out-of-range parameter is named**, so the operator can read the refusal', () => {
    const result = authorize(ACTION, { value: 5 }, GRANTED);
    expect(result.param).toBe('value');
    expect(result.detail ?? '').toContain('value');
  });

  it('the **result has exactly two outcomes** (the `needs_confirmation` outcome is gone)', () => {
    const verdicts = new Set<string>();
    verdicts.add(authorize(ACTION, { value: 100 }, GRANTED).verdict);
    verdicts.add(authorize(ACTION, { value: 5 }, GRANTED).verdict);
    verdicts.add(authorize(ACTION, { value: 100 }, { actions: {} }).verdict);
    verdicts.add(authorize({ ...ACTION, danger: 'destructive' }, { value: 100 }, GRANTED).verdict);
    expect([...verdicts].sort()).toEqual(['denied', 'ok']);
  });
});

describe('authorisation · criteria for a parameter range', () => {
  it('no guard declared → the range declared by the parameter itself applies (0..255, the full range)', () => {
    const noGuard: ActionDef = { ...ACTION, guard: undefined };
    const granted: GrantedActions = { actions: { 'backlight.set': undefined } };
    const result = authorize(noGuard, { value: 5 }, granted);
    expect(result.verdict).toBe('ok');
  });

  it('outside the range declared by the parameter → denied (a guard is only a narrower range)', () => {
    const noGuard: ActionDef = { ...ACTION, guard: undefined };
    const granted: GrantedActions = { actions: { 'backlight.set': undefined } };
    const result = authorize(noGuard, { value: 999 }, granted);
    expect(result.verdict).toBe('denied');
  });

  it('**the granted set narrows the range** → the narrower range applies (what the operator granted wins)', () => {
    const granted: GrantedActions = { actions: { 'backlight.set': { value: { min: 200, max: 255 } } } };
    expect(authorize(ACTION, { value: 100 }, granted).verdict).toBe('denied');
    expect(authorize(ACTION, { value: 220 }, granted).verdict).toBe('ok');
  });

  it('**string parameters do not use min/max** (applying them to a string only produces false rejections)', () => {
    const note: ActionDef = {
      ...ACTION,
      id: 'note.set',
      params: { text: { type: 'string', maxLength: 64 } },
      guard: undefined,
      command: 'echo {text} > /tmp/note',
    };
    const granted: GrantedActions = { actions: { 'note.set': undefined } };
    expect(authorize(note, { text: 'x; reboot' }, granted).verdict).toBe('ok');
  });
});

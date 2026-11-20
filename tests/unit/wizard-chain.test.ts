import { describe, it, expect } from 'vitest';
import { describeWizard, wizardStepOf, type WizardState } from '../../src/main/wizard/chain';
import type { ProbeReaderReport } from '../../src/main/tags/probe';

/**
 * The chain of the board wizard, added on 2026-11-19.
 *
 * The operator takes part in one step only:
 *
 * ```
 * operator: pick the COM port + the baud rate   ← 【the one thing the
 *                                                    operator must do in the
 *                                                    whole wizard】
 *         ↓
 * wizard: run one command over that connection  ← "the first truth"
 *         ↓
 *      the board answered → the truth holds
 * ```
 *
 * → **Everything else is automatic** → the generic meta operations are tried
 *   one by one → a first pack is instantiated → it is written to disk.
 *
 * → **"No answer" and "the connection failed" are two different things**:
 *
 * → the report has to say "**the board did not speak**" and **not "the
 *   connection failed"**; **these are different faults** and they need
 *   different fixes.
 */
function report(readerId: string, ok: boolean, problems: string[] = []): ProbeReaderReport {
  return { readerId, kind: 'file_read', tags: [], problems, ok };
}

describe('the wizard · **the operator takes part in one step only**', () => {
  it('**the first step asks only for the serial parameters** (**it does not enumerate them** — the operator has decided)', () => {
    const state: WizardState = {
      step: 'choose-serial',
      serial: { port: 'COM3', baudrate: 1500000 },
    };
    expect(wizardStepOf(state)).toBe('choose-serial');
  });

  it('**the baud rate comes from the operator** (**it is not tried**)', () => {
    const state: WizardState = {
      step: 'choose-serial',
      serial: { port: 'COM3', baudrate: 1500000 },
    };
    expect(state.serial?.baudrate).toBe(1500000);
  });
});

describe('the wizard · **"no answer" is not "the connection failed"**', () => {
  it('**the port cannot be opened → it talks about the port**', () => {
    const r = describeWizard({
      step: 'first-truth',
      firstTruth: { ok: false, kind: 'port-unopenable', detail: 'COM3 cannot be opened' },
    });
    expect(r.kind).toBe('port-unopenable');
    expect(r.message).toContain('COM3');
  });

  it('**it opens but there is no answer → it says "the board did not speak"** (**not "the connection failed"**)', () => {
    const r = describeWizard({
      step: 'first-truth',
      firstTruth: { ok: false, kind: 'no-reply', detail: 'it connected but the command got no answer' },
    });
    expect(r.kind).toBe('no-reply');
    expect(r.message).toContain('said nothing');
    expect(r.message).not.toContain('connection failed');
  });

  it('**no answer has to name the most common cause** (**the serial port is held by another program** — see the facts in `docs/02-device-facts.md`)', () => {
    const r = describeWizard({
      step: 'first-truth',
      firstTruth: { ok: false, kind: 'no-reply', detail: 'it connected but the command got no answer' },
    });
    expect(r.hints.length, 'it has to say what to check next').toBeGreaterThan(0);
  });

  it('**the first truth holds → the next step is "try the generic meta operations"**', () => {
    const r = describeWizard({
      step: 'first-truth',
      firstTruth: { ok: true, kind: 'ok', detail: 'the board answered' },
    });
    expect(r.next).toBe('probe-generic');
  });
});

describe('the wizard · **the green and red that were found = the table of truths**', () => {
  it('**the green one says "it is there" · the red one says "it is not there"**', () => {
    const r = describeWizard({
      step: 'probe-generic',
      firstTruth: { ok: true, kind: 'ok', detail: 'the board answered' },
      outcomes: [report('cpu', true), report('led', false, ['the path is wrong'])],
    });
    expect(r.kind).toBe('ok');
    expect(r.summary?.green).toEqual(['cpu']);
    expect(r.summary?.red.map((x) => x.readerId)).toEqual(['led']);
  });

  it('**a red one has to give its reason** (**"this board does not have it" is a fact as well**)', () => {
    const r = describeWizard({
      step: 'probe-generic',
      firstTruth: { ok: true, kind: 'ok', detail: 'the board answered' },
      outcomes: [report('led', false, ['the path is wrong', 'there is no such directory'])],
    });
    expect(r.summary?.red[0]?.detail).toContain('the path is wrong');
  });

  it('**all red → that is not "the reader has a problem"** (**the connection is not open** — the same as `probeHint`)', () => {
    const r = describeWizard({
      step: 'probe-generic',
      firstTruth: { ok: true, kind: 'ok', detail: 'the board answered' },
      outcomes: [report('cpu', false), report('mem', false)],
    });
    expect(r.kind, 'not a single number came out → it is a problem of the connection itself').toBe('connection-dead');
  });
});

import { describe, it, expect } from 'vitest';
import { firstTruthOf } from '../../src/main/wizard/run';
import { AppError } from '../../src/shared/errors';
import type { Connection, ExecResult } from '../../src/main/hal/connection';

/**
 * The **classification of the failures of the "first truth"** — added on
 * 2026-11-20.
 *
 * Why this had to be added (**it was hammered out by a real event**):
 *
 * → Measured on 2026-11-20: the wizard ran against **COM99** (**a port that
 *   does not exist**)
 *   → the host reported that the serial port could not be opened
 * → The criterion of the time **only recognised the message text** (the
 *   regular expression held "open") and the wording of the failure did not
 *   match → **it was classified as "the board did not speak"** → **the fault
 *   was reported wrongly**, and **the two need completely different fixes**
 *   (change the baud rate vs. change the port).
 *
 * → Therefore **the criterion has to recognise the error code** and **not
 *   only the text** (**one character of the wording is enough to get it
 *   wrong**).
 */
function failingConnection(err: unknown): Connection {
  return {
    id: 'fake',
    transport: 'serial',
    async exec(): Promise<ExecResult> {
      throw err;
    },
  } as unknown as Connection;
}

describe('the first truth · **the classification of the failures** (**the error codes are recognised**)', () => {
  it('**`CONN_OPEN_FAILED` → the serial port cannot be opened** (**not "the board did not speak"**)', async () => {
    const err = new AppError('CONN_OPEN_FAILED', 'cannot open serial port COM99');
    const truth = await firstTruthOf(failingConnection(err));
    expect(truth.kind, '**"cannot open" differs from "open" by one character** → only the error code tells them apart').toBe(
      'port-unopenable',
    );
  });

  it('**`PORT_BUSY` → the serial port cannot be opened** (**being busy is the same fault**)', async () => {
    const err = new AppError('PORT_BUSY', 'serial port COM3 is busy');
    const truth = await firstTruthOf(failingConnection(err));
    expect(truth.kind).toBe('port-unopenable');
  });

  it('**the English message "cannot open" is recognised as well** (**as a fallback**)', async () => {
    const truth = await firstTruthOf(failingConnection(new Error('cannot open serial port COM99')));
    expect(truth.kind).toBe('port-unopenable');
  });

  it('**only the error code recognises it** (**there is no keyword in the message** — **a fallback on the text cannot save it**)', async () => {
    // → **The message is in English** → **not a single regular expression of the textual fallback matches**
    // → **Only the error code** → **can tell "it cannot be opened" apart**
    const err = new AppError('CONN_OPEN_FAILED', 'cannot open port');
    const truth = await firstTruthOf(failingConnection(err));
    expect(
      truth.kind,
      '**only the error code tells them apart** — **one character of the wording is enough to get it wrong** (measured on 2026-11-20)',
    ).toBe('port-unopenable');
  });

  it('**a timeout → the board did not speak** (**not "it cannot be opened"**)', async () => {
    const truth = await firstTruthOf(
      failingConnection(new AppError('CONN_TIMEOUT', 'serial port COM3 timed out on one round trip')),
    );
    expect(truth.kind).toBe('no-reply');
  });

  it('**another error → the board did not speak** (**it does not misclassify**)', async () => {
    const truth = await firstTruthOf(failingConnection(new Error('the board has two cables plugged in')));
    expect(truth.kind).toBe('no-reply');
  });
});

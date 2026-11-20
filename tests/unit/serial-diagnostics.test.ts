import { describe, it, expect, vi } from 'vitest';
import { SerialConnection, type SerialPortFactory } from '../../src/main/hal/serial';

/**
 * The **shape of the failure** of a serial exec that times out.
 *
 * Why it is a test of its own:
 *
 * It was really hit on a real board (2026-11-13): the `serial-server.py`
 * that the acceptance of plan 1 had left on the host **opened COM3
 * exclusively** and ate the answers — **the board was alive and the serial
 * line worked, but the exec of the application never got an answer**.
 *
 * The application only sees a "timeout" then — and the first suspect of a
 * timeout should be "**the answers were eaten by another program**", not "the
 * board is slow".
 *
 * **The criterion is "does the message carry a next step that can be
 * executed", not "does the message sound good".**
 */

const log = { write: vi.fn(), close: vi.fn(), filePath: 'x' };

/** A serial port that opens but never answers — it simulates the answers being eaten by another program */
function silentPort(): SerialPortFactory {
  return async () => ({
    write() {
      // Nothing comes back — the reply was eaten somewhere else
    },
    onData() {
      /* no-op */
    },
    onError() {
      /* no-op */
    },
    async close() {
      /* no-op */
    },
  });
}

function makeConnection(port: string): SerialConnection {
  return new SerialConnection(
    {
      id: 's',
      label: 's',
      transport: 'serial',
      options: { port, baudrate: 1500000 },
    },
    log as never,
    silentPort(),
  );
}

describe('a serial exec times out → it says what to check next', () => {
  it('the result of the timeout carries a hint, **and it names the port**', async () => {
    const conn = makeConnection('COM7');
    await conn.open();

    const result = await conn.exec('echo hello', { timeoutMs: 30 });

    expect(result.timedOut).toBe(true);
    // **The convention of the uniform 124 may not change** (fact G1)
    expect(result.exitCode).toBe(124);
    expect(result.hint).toBeTruthy();
    expect(result.hint).toContain('swallowed');
    expect(result.hint).toContain('COM7');
  });

  it('the hint names the pitfall of the **exclusive serial port** (it was really hit on a real board)', async () => {
    const conn = makeConnection('COM3');
    await conn.open();

    const result = await conn.exec('echo hello', { timeoutMs: 30 });

    expect(result.hint).toContain('serial port');
  });
});

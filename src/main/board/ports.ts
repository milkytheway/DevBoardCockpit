/**
 * **The serial ports of this machine** ✓ — the real implementation ✓.
 *
 * → The `serialport` package carries a **native binary** ✓ → it is loaded
 *   **here and not at the top of the file** ✓ → the modules that talk about
 *   ports can be loaded (and tested ✓) without it ✓.
 * → The port is **opened, written to and read** ✓ → the only honest way to
 *   find out whether a port is the console of the board is to ask it ✓.
 */
import { StringDecoder } from 'node:string_decoder';
import type { PortProbe } from './detect';

/** The ports this machine has ✓ */
export async function listHostPorts(): Promise<{ path: string }[]> {
  const { SerialPort } = await import('serialport');
  const ports = await SerialPort.list();
  return ports.map((port) => ({ path: port.path }));
}

/**
 * Open a port, send an empty line, and read what comes back ✓.
 *
 * → **An empty line** ✓ (\"\\\\r\" ✓) → a console that echoes ✓ answers with
 *   a new prompt ✓ → **that is the answer** ✓.
 * → **The port cannot be opened** ✓ (another program holds it ✓ · the driver
 *   is missing ✓) → **that is an exception** ✓ → the caller can tell "nobody
 *   answered" from "I could not even ask" ✓ (**the two are different
 *   things** ✓).
 */
export async function probeHostPort(
  path: string,
  baudRate: number,
  waitMs: number,
): Promise<string> {
  const { SerialPort } = await import('serialport');
  const port = new SerialPort({ path, baudRate, autoOpen: false });
  let received = '';
  const decoder = new StringDecoder('utf8');
  port.on('data', (buf: Buffer) => {
    received += decoder.write(buf);
  });
  // → **The port reports failures as an 'error' event** ✓ (it cannot be
  //   opened ✗ · the driver says no ✗) → **an 'error' event without a
  //   listener throws** ✗ and that throw lands inside the promise chain ✗ →
  //   it comes out as **a rejection that nobody handles** ✗ (seen on
  //   2026-11-22 ✓ — the serial HAL listens to its own port ✗ but this probe
  //   does not ✗).
  // → The listener only keeps the event from becoming an uncaught throw ✓ —
  //   the failure itself is reported by the promise below ✓ (the caller tells
  //   "nobody answered" from "I could not even ask" ✓).
  port.on('error', () => undefined);
  await port.open();
  try {
    port.write('\r');
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && received.trim().length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return received;
  } finally {
    if (port.isOpen) {
      await new Promise<void>((resolve) => {
        port.close(() => resolve());
      });
    }
  }
}

/** The real probe ✓ (the one the host uses ✓) */
export const hostPortProbe: PortProbe = {
  list: listHostPorts,
  probe: probeHostPort,
};

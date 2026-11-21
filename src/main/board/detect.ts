/**
 * **Detecting the truth about the board on this machine.**
 *
 * ── Why this module exists ──
 *
 * A shipped connection profile cannot carry the values that belong to **one
 * machine and one board**: the serial number of the board, its address, the
 * serial port the console is on. Those values were therefore replaced with
 * placeholders when the repository was published (the SSH host became
 * `192.0.2.100` — an RFC 5737 documentation address — and the ADB serial
 * became `0000000000000000`), and a placeholder profile is a profile that
 * **cannot connect**.
 *
 * → The values have to be **detected** ✓ — not typed, and not shipped.
 *
 * ── The rules (all of them "never guess" ✓) ──
 *
 * | # | Rule | Why |
 * |---|---|---|
 * | 1 | **Exactly one candidate → use it** ✓ | One candidate is not a choice ✓ — **several candidates are a question for the user** ✓ |
 * | 2 | **The board says which one it is** ✓ | The model in `/proc/device-tree/model` is read back from the board ✓ → a device that is not this board is not adopted ✓ |
 * | 3 | **A detection that fails is reported, not hidden** ✓ | The old error said "cannot reach 192.0.2.100" — the address was the placeholder ✓ and the message did not say so ✓ |
 *
 * → **Nothing here writes anything** ✓ — writing is the resolver's business
 *   (`resolve.ts` ✓).
 */
import { runProcess, type SpawnResult } from '../util/spawn';
import { Socket } from 'node:net';

/** One device in the output of `adb devices`. */
export interface AdbDevice {
  /** The serial (the first column) */
  serial: string;
  /** The state word: `device` / `offline` / `unauthorized` / … */
  state: string;
  /** The raw state text (it may carry `no permissions (user in plugdev group)`) */
  stateText: string;
}

/** The runner — injected so that the tests never need adb. */
export type ProcessRunner = (
  command: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<SpawnResult>;

export interface DetectDeps {
  /** The adb executable (the machine-specific path comes from the settings ✓) */
  adbPath?: string;
  /** The runner (the real one by default ✓) */
  runner?: ProcessRunner;
}

/**
 * The documentation addresses of **RFC 5737** ✓.
 *
 * → They are the addresses the publishing step used to replace the real ones
 *   with ✓ → **an address in one of these ranges is a placeholder** ✓ and
 *   never a board.
 */
const PLACEHOLDER_HOSTS: readonly string[] = ['192.0.2.', '198.51.100.', '203.0.113.'];

/**
 * Is this host one of the documentation addresses (a placeholder ✓)?
 *
 * → The point is not to refuse to connect ✓ — the point is that **the error
 *   message has to say "this is the placeholder, the board has not been set
 *   up yet"** ✓ instead of "cannot reach 192.0.2.100" ✓ (which sends the
 *   user looking for a network problem that does not exist ✓).
 */
export function isPlaceholderHost(host: string): boolean {
  const trimmed = host.trim();
  return PLACEHOLDER_HOSTS.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * Is this serial the placeholder ✓?
 *
 * → The publishing step wrote `0000000000000000` ✓ → **no board has that
 *   serial number** ✓ (an adb serial is a real one ✓).
 */
export function isPlaceholderSerial(serial: string): boolean {
  return /^0+$/.test(serial.trim());
}

/**
 * Parse the output of `adb devices`.
 *
 * → The rows that are **not** devices are dropped ✓: the header line ✓ and
 *   the daemon noise (`* daemon not running; starting now at tcp:5037` ✓).
 * → The state text is kept in full ✓ (`unauthorized` alone does not say
 *   *why* ✗ — the full text does ✓).
 */
export function parseAdbDevices(stdout: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('List of devices')) continue;
    if (line.startsWith('*')) continue;
    const parts = line.split(/\s+/);
    const serial = parts[0] ?? '';
    if (serial.length === 0) continue;
    const stateText = parts.slice(1).join(' ').trim();
    devices.push({ serial, state: parts[1] ?? '', stateText });
  }
  return devices;
}

/**
 * The devices adb sees right now ✓.
 *
 * → **A failing adb is not an error** ✓ — it means "there is no board on
 *   adb" ✓ (adb missing ✓ · the daemon not running ✓) → an empty list ✓.
 */
export async function listAdbDevices(deps: DetectDeps = {}): Promise<AdbDevice[]> {
  const runner = deps.runner ?? runProcess;
  try {
    const result = await runner(deps.adbPath ?? 'adb', ['devices'], { timeoutMs: 8000 });
    return parseAdbDevices(result.stdout);
  } catch {
    return [];
  }
}

/**
 * The IPv4 addresses in the output of `ip -4 addr show` ✓.
 *
 * → **The loopback address is not one of them** ✓ (127.0.0.1 is the board
 *   talking to itself ✓ — it is never the address of the board on the
 *   network ✓).
 */
export function parseIPv4(stdout: string): string[] {
  const found: string[] = [];
  for (const match of stdout.matchAll(/\binet\s+(\d{1,3}(?:\.\d{1,3}){3})\/\d+/g)) {
    const address = match[1] ?? '';
    if (address.length === 0) continue;
    if (address.startsWith('127.')) continue;
    if (!found.includes(address)) found.push(address);
  }
  return found;
}

/**
 * The address of the board, read from the board itself ✓.
 *
 * → `adb -s <serial> shell ip -4 addr show` ✓ → the first address that is
 *   not the loopback ✓.
 * → **No address → `null`** ✓ (not a guess ✓ — an address that is not there
 *   is not invented ✓).
 */
export async function readBoardIPv4(serial: string, deps: DetectDeps = {}): Promise<string | null> {
  const runner = deps.runner ?? runProcess;
  try {
    const result = await runner(
      deps.adbPath ?? 'adb',
      ['-s', serial, 'shell', 'ip -4 addr show'],
      { timeoutMs: 8000 },
    );
    const addresses = parseIPv4(result.stdout);
    return addresses[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The model the board reports ✓ (`/proc/device-tree/model` ✓).
 *
 * → It is the **proof** that the device is the board we are looking for ✓ —
 *   without it, "the only connected device" is only a guess ✓.
 * → `null` when it cannot be read ✓ (an unauthorized device cannot be asked
 *   anything ✓).
 */
export async function readBoardModel(serial: string, deps: DetectDeps = {}): Promise<string | null> {
  const runner = deps.runner ?? runProcess;
  try {
    const result = await runner(
      deps.adbPath ?? 'adb',
      ['-s', serial, 'shell', 'cat /proc/device-tree/model'],
      { timeoutMs: 8000 },
    );
    const model = result.stdout.replace(/\0/g, '').trim();
    return model.length > 0 ? model : null;
  } catch {
    return null;
  }
}

/**
 * **Does this address answer?** ✓
 *
 * → A TCP connection ✓ (not an ssh handshake ✓ — the question is "is
 *   anything listening there" ✓).
 * → **The timeout is short** ✓ (1.5 s ✓): this runs before every connection
 *   ✓ and a host that does not answer must not hold the interface ✓.
 */
export type AddressProbe = (host: string, port: number, timeoutMs?: number) => Promise<boolean>;

/** The real probe ✓ (a TCP connection ✓) */
export const tcpAddressProbe: AddressProbe = async (
  host: string,
  port: number,
  timeoutMs = 1500,
): Promise<boolean> => {
  const socket = new Socket();
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
};

/**
 * The minimal serial port surface the detection needs ✓.
 *
 * → **The `serialport` package is not imported here** ✓ — it carries a
 *   native binary ✓ and this module has to stay loadable without it ✓
 *   (the sandbox cannot load the Windows binary ✓ · the tests need the
 *   module ✓).
 */
export interface PortProbe {
  /** Open the port and wait this long for something to come back */
  probe(path: string, baudRate: number, waitMs: number): Promise<string>;
  /** The ports this machine has */
  list(): Promise<{ path: string }[]>;
}

/**
 * Try the ports one by one and report the ones that answer ✓.
 *
 * → **A port that says nothing is not the board's console** ✓ — that is the
 *   only honest criterion ✓ (the port existing proves nothing ✓).
 * → **A port that could not be opened is a third thing** ✓ — another program
 *   holds it ✓ (the runtime's own connection ✗) → **it is not "silent"** ✓
 *   → it must never make the application look for another port ✓ (the port
 *   is the right one ✓ · it is just busy ✓ → the honest message is "the
 *   port is busy" ✓).
 *
 * @returns the ports that answered ✓ · the ports that stayed silent ✓ · the
 *   ports that could not be opened ✓ — **one answering port means "this is
 *   it" ✓ · several mean "the user has to say which one" ✓ · none mean "the
 *   console is not connected" ✓**
 */
export async function probeSerialPorts(
  ports: readonly { path: string }[],
  baudRate: number,
  probe: PortProbe,
  waitMs = 800,
): Promise<{ answering: string[]; silent: string[]; busy: string[] }> {
  const answering: string[] = [];
  const silent: string[] = [];
  const busy: string[] = [];
  for (const port of ports) {
    let text = '';
    try {
      text = await probe.probe(port.path, baudRate, waitMs);
    } catch {
      // **The port could not be opened** → another program holds it ✓
      busy.push(port.path);
      continue;
    }
    if (text.trim().length > 0) answering.push(port.path);
    else silent.push(port.path);
  }
  return { answering, silent, busy };
}

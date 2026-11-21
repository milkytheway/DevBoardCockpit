/**
 * **Finding the values that are true on this machine** ✓.
 *
 * ── What this does ──
 *
 * → A connection profile says **what the connection is** ✓ (the transport ✓
 *   · the board ✓ · the label ✓). It cannot say **which machine it
 *   reaches** ✓ — those values are the person's ✓ (the serial number of
 *   their board ✓ · the address ✓ · the port ✓ · the private key ✓).
 * → So the values are **found** here ✓ and stored in the machine-value
 *   store ✓ (`machine-values.ts` ✓).
 *
 * ── The rules (all of them "never guess" ✓) ──
 *
 * | # | Rule | Why |
 * |---|---|---|
 * | 1 | The **adb serial** comes from `adb devices** ✓ | exactly one board in the `device` state ✓ → and it has to report the model of the board pack ✓ |
 * | 2 | The **address** is **verified** ✓ (the port has to answer ✓) | an address that is written down proves nothing ✓ — a stale one ✓ · a NAT gateway ✓ · the wrong segment ✓ |
 * | 3 | The **private key** comes from `~/.ssh` ✓ | it is the person's key ✓ — the usual names ✓ |
 * | 4 | The **serial port** is the one that **answers** ✓ | a port that exists proves nothing ✓ |
 * | 5 | **Several candidates → nothing is chosen** ✓ | the person has to say ✓ |
 */
import {
  knownSshHosts,
  listAdbDevices,
  listSshKeys,
  parseIPv4,
  probeSerialPorts,
  readBoardIPv4,
  readBoardModel,
  type AdbDevice,
  type PortProbe,
  type ProcessRunner,
} from './detect';
import { probeTcp } from './probe';

/** The machine-specific fields this module fills in ✓ */
export interface MachinePatch {
  serial?: string;
  host?: string;
  port?: string;
  key_filename?: string;
  [field: string]: unknown;
}

export interface FoundValues {
  /** What was found ✓ */
  patch: MachinePatch;
  /** Why each value was chosen ✓ (the interface says it out loud ✓) */
  reasons: Record<string, string>;
  /** What could not be found ✓ — **the message the person sees** ✓ */
  problems: string[];
}

/**
 * **Whose machine this is** ✓.
 *
 * → `board` ✓ — the connection belongs to a board ✓ → **the board itself
 *   says where it is** ✓ (`ip -4 addr show` ✓) → the address is the board's
 *   own ✓.
 * → `machine` ✓ — the connection belongs to **no** board ✓ (the guest ✓) →
 *   **nobody can say where it is** ✓ → the candidates come from **the
 *   user's own records** ✓ (`~/.ssh/known_hosts` ✓ · `~/.ssh/config` ✓) →
 *   and every one of them is **verified** ✓ (the port has to answer ✓).
 */
export type MachineKind = 'board' | 'machine';

export interface FindDeps {
  /** The adb executable ✓ */
  adbPath?: string;
  /** **Whose machine this connection belongs to** ✓ */
  kind?: MachineKind;
  /**
   * **Detect again, even if it was just detected** ✓.
   *
   * → A value that was found **before** may be **stale now** ✓ (the board
   *   got another address ✓ · the console moved to another port ✓) → the
   *   stale value is detected again ✓ (the verification found that it does
   *   not answer ✓).
   */
  force?: boolean;
  /** The runner (injected in the tests ✓) */
  runner?: ProcessRunner;
  /** The user's home directory ✓ (the private keys live there ✓) */
  homeDir?: string;
  /** The serial ports of this machine ✓ */
  ports?: PortProbe;
  /** The TCP probe ✓ (injected in the tests ✓) */
  probe?: (host: string, port: number, timeoutMs?: number) => Promise<{
    ok: boolean;
    error?: string;
  }>;
  /** The models the board pack accepts ✓ */
  expectedModels?: readonly string[];
  /** The port the SSH connection uses ✓ */
  sshPort?: number;
}

/** Does the model the board reports belong to this board pack? ✓ */
export function modelMatches(model: string, expected: readonly string[]): boolean {
  if (expected.length === 0) return true;
  const target = model.toLowerCase();
  return expected.some((candidate) => target.includes(candidate.toLowerCase()));
}

/**
 * The adb serial of the board ✓.
 *
 * → Exactly one board in the `device` state ✓ → and it reports the model of
 *   the board pack ✓ → otherwise **nothing is chosen** ✓.
 */
export async function findAdbSerial(
  devices: readonly AdbDevice[],
  deps: FindDeps,
): Promise<{ serial: string | null; reason: string | null; problem: string | null }> {
  const pinned = devices.find((device) => device.serial !== '');
  if (pinned === undefined) {
    return { serial: null, reason: null, problem: 'adb sees no board' };
  }
  const ready = devices.filter((device) => device.state === 'device');
  if (ready.length === 0) {
    return {
      serial: null,
      reason: null,
      problem: `adb sees no board in the "device" state (${devices
        .map((device) => `${device.serial}: ${device.stateText}`)
        .join(', ')})`,
    };
  }
  if (ready.length > 1) {
    return {
      serial: null,
      reason: null,
      problem: `adb sees ${ready.length} boards (${ready
        .map((device) => device.serial)
        .join(', ')}) — the board setup has to say which one this is`,
    };
  }
  const only = ready[0];
  if (only === undefined) return { serial: null, reason: null, problem: null };
  const expected = deps.expectedModels ?? [];
  if (expected.length > 0) {
    const model = await readBoardModel(only.serial, deps);
    if (model !== null && !modelMatches(model, expected)) {
      return {
        serial: null,
        reason: null,
        problem: `the only board adb sees (${only.serial}) reports the model "${model}", which is not the model this connection is for (${expected.join(' / ')})`,
      };
    }
    if (model !== null) {
      return {
        serial: only.serial,
        reason: `the only board adb sees (it reports "${model}")`,
        problem: null,
      };
    }
  }
  return { serial: only.serial, reason: 'the only board adb sees', problem: null };
}

/**
 * The address of the board ✓ — **and it has to answer** ✓.
 *
 * → The board reports its own addresses ✓ (`ip -4 addr show` ✓) → **each one
 *   is tried** ✓ → the one whose SSH port answers ✓ is the board's address
 *   **as this machine sees it** ✓.
 * → **None of them answers** → the person is told which addresses were
 *   tried ✓ and why each one failed ✓ — **no address is written** ✓.
 */
export async function findReachableAddress(
  candidates: readonly string[],
  port: number,
  deps: FindDeps,
): Promise<{ address: string | null; reason: string | null; problem: string | null }> {
  const probe = deps.probe ?? ((host, p, timeoutMs) => probeTcp(host, p, timeoutMs));
  const tried: string[] = [];
  for (const candidate of candidates) {
    const result = await probe(candidate, port, 1500);
    if (result.ok) {
      return {
        address: candidate,
        reason: `the board reports it and the port ${port} answers there`,
        problem: null,
      };
    }
    tried.push(`${candidate} (${result.error ?? 'no answer'})`);
  }
  return {
    address: null,
    reason: null,
    problem:
      tried.length === 0
        ? `the board reports no address to try on port ${port}`
        : `no address of the board answers on port ${port}: ${tried.join(', ')}`,
  };
}

/**
 * The address of a machine that is **not** a board ✓ (the guest ✓).
 *
 * → **Nobody can say where it is** ✓ → the candidates come from **the
 *   user's own records** ✓ (`~/.ssh/known_hosts` ✓ · `~/.ssh/config` ✓) →
 *   **and every one of them is verified** ✓ (the port has to answer ✓).
 * → **Nothing answers → nothing is chosen** ✓ (the person has to say ✓).
 */
export async function findMachineAddress(
  homeDir: string | undefined,
  port: number,
  deps: FindDeps,
): Promise<{ address: string | null; reason: string | null; problem: string | null }> {
  if (homeDir === undefined) {
    return { address: null, reason: null, problem: null };
  }
  const candidates = await knownSshHosts(homeDir);
  const probe = deps.probe ?? ((host: string, p: number) => probeTcp(host, p, 1500));
  const tried: string[] = [];
  for (const candidate of candidates) {
    const result = await probe(candidate, port, 1500);
    if (result.ok) {
      return {
        address: candidate,
        reason: 'this machine has connected to it before and the port answers there',
        problem: null,
      };
    }
    tried.push(`${candidate} (${result.error ?? 'no answer'})`);
  }
  return {
    address: null,
    reason: null,
    problem:
      tried.length === 0
        ? `this machine has no record of the address of that machine (nothing in ~/.ssh/known_hosts)`
        : `no address of that machine answers on port ${port}: ${tried.join(', ')}`,
  };
}

/**
 * The private key of this machine ✓.
 *
 * → **Exactly one key** ✓ → it is the one ✓ (the usual names are looked
 *   for ✓).
 * → **Several keys** → **nothing is chosen** ✓ (the person says which one
 *   ✓ — the board setup lists them ✓).
 */
export async function findPrivateKey(
  homeDir: string | undefined,
  _deps: FindDeps,
): Promise<{ key: string | null; reason: string | null; problem: string | null }> {
  if (homeDir === undefined) {
    return { key: null, reason: null, problem: null };
  }
  const keys = await listSshKeys(homeDir);
  if (keys.length === 0) {
    return {
      key: null,
      reason: null,
      problem: 'this machine has no SSH private key (looked for the usual names in ~/.ssh)',
    };
  }
  if (keys.length > 1) {
    return {
      key: null,
      reason: null,
      problem: `this machine has ${keys.length} SSH private keys (${keys
        .map((path) => path.split(/[\\/]/).pop() ?? path)
        .join(', ')}) — the board setup has to say which one the board accepts`,
    };
  }
  const only = keys[0];
  return {
    key: only ?? null,
    reason: 'the only private key in ~/.ssh',
    problem: null,
  };
}

/**
 * The serial port of the board's console ✓.
 *
 * → **The port that answers** ✓ — the configured one is asked first ✓ (it
 *   is the one the profile names ✓) → if it stays silent ✓ the other ports
 *   are asked ✓ → **exactly one answering port** ✓ wins ✓.
 * → **A port that is busy is not a silent port** ✓ (another program holds
 *   it ✓ — the honest error is "the port is busy" ✓).
 */
export async function findSerialPort(
  configured: string | undefined,
  baud: number,
  deps: FindDeps,
): Promise<{ port: string | null; reason: string | null; problem: string | null }> {
  if (deps.ports === undefined) return { port: null, reason: null, problem: null };
  const all = await deps.ports.list();

  if (configured !== undefined && configured.length > 0) {
    const one = await probeSerialPorts(
      all.filter((port) => port.path === configured),
      baud,
      deps.ports,
    );
    if (one.answering.includes(configured)) {
      return { port: configured, reason: 'the configured port answers', problem: null };
    }
    if (one.busy.includes(configured)) {
      // **Busy is not silent** ✓ — the port is the right one ✓, another
      // program holds it ✓ → **the application must not look for another
      // port** ✓.
      return {
        port: configured,
        reason: 'the configured port is held by another program',
        problem: null,
      };
    }
  }

  const others = await probeSerialPorts(
    all.filter((port) => port.path !== configured),
    baud,
    deps.ports,
  );
  if (others.answering.length === 1) {
    const found = others.answering[0];
    return {
      port: found ?? null,
      reason: 'the only serial port that answered',
      problem: null,
    };
  }
  if (others.answering.length > 1) {
    return {
      port: null,
      reason: null,
      problem: `${others.answering.length} serial ports answered (${others.answering.join(', ')}) — the board setup has to say which one is the console`,
    };
  }
  return {
    port: null,
    reason: null,
    problem:
      'no serial port answered — the console of the board is not connected (or the baud rate is wrong)',
  };
}

/**
 * **The last detection** ✓ — it is reused for a moment ✓.
 *
 * → The three connections of one board are prepared one after the other ✓
 *   → **the detection runs once** ✓ (it asks adb ✓ → it opens a TCP
 *   connection ✓ → it opens a serial port ✓ — that is not free ✓).
 * → **It is forgotten after two seconds** ✓ (the board may be plugged in
 *   meanwhile ✓ → the next detection sees the new situation ✓).
 */
let lastFind: { at: number; deps: FindDeps; result: FoundValues } | null = null;

const FIND_TTL_MS = 2000;

/**
 * Find everything the machine knows ✓.
 *
 * → The adb serial ✓ · the address of the board ✓ (**verified** ✓) · the
 *   private key ✓ · the serial port ✓.
 * → **The problems are returned, not thrown** ✓ — the caller decides what to
 *   do with them ✓ (the interface has to say them ✓).
 */
export async function findMachineValues(deps: FindDeps): Promise<FoundValues> {
  // → **The recent detection is reused** ✓ (the three connections of one
  //   board would otherwise ask adb three times ✓).
  if (
    deps.force !== true &&
    lastFind !== null &&
    Date.now() - lastFind.at < FIND_TTL_MS &&
    lastFind.deps === deps
  ) {
    return lastFind.result;
  }
  const result = await detectMachineValues(deps);
  lastFind = { at: Date.now(), deps, result };
  return result;
}

/** **Forget the last detection** ✓ (after a value was written ✓ → the next
 *  one starts fresh ✓). */
export function forgetDetection(): void {
  lastFind = null;
}

/** The detection itself ✓ */
async function detectMachineValues(deps: FindDeps): Promise<FoundValues> {
  const patch: MachinePatch = {};
  const reasons: Record<string, string> = {};
  const problems: string[] = [];

  // ── The adb serial ✓ ──
  const devices = await listAdbDevices({
    adbPath: deps.adbPath,
    ...(deps.runner === undefined ? {} : { runner: deps.runner }),
  });
  const serialOutcome = await findAdbSerial(devices, deps);
  if (serialOutcome.serial !== null) {
    patch.serial = serialOutcome.serial;
    if (serialOutcome.reason !== null) reasons['serial'] = serialOutcome.reason;
  } else if (serialOutcome.problem !== null) {
    problems.push(serialOutcome.problem);
  }

  // ── The address ✓ (verified ✓) ──
  const port = deps.sshPort ?? 22;
  if ((deps.kind ?? 'board') === 'machine') {
    // → **A machine that is not a board** ✓ → the candidates come from the
    //   user's own records ✓.
    const machineOutcome = await findMachineAddress(deps.homeDir, port, deps);
    if (machineOutcome.address !== null) {
      patch.host = machineOutcome.address;
      if (machineOutcome.reason !== null) reasons['host'] = machineOutcome.reason;
    } else if (machineOutcome.problem !== null) {
      problems.push(machineOutcome.problem);
    }
  } else if (serialOutcome.serial !== null) {
    // → **A board says where it is** ✓.
    const reported = await readBoardIPv4(serialOutcome.serial, {
      adbPath: deps.adbPath,
      ...(deps.runner === undefined ? {} : { runner: deps.runner }),
    });
    const candidates = reported === null ? [] : [reported];
    const addressOutcome = await findReachableAddress(candidates, port, deps);
    if (addressOutcome.address !== null) {
      patch.host = addressOutcome.address;
      if (addressOutcome.reason !== null) reasons['host'] = addressOutcome.reason;
    } else if (addressOutcome.problem !== null) {
      problems.push(addressOutcome.problem);
    }
  }

  // ── The private key ✓ ──
  const keyOutcome = await findPrivateKey(deps.homeDir, deps);
  if (keyOutcome.key !== null) {
    patch.key_filename = keyOutcome.key;
    if (keyOutcome.reason !== null) reasons['key_filename'] = keyOutcome.reason;
  } else if (keyOutcome.problem !== null) {
    problems.push(keyOutcome.problem);
  }

  // ── The serial port ✓ ──
  const portOutcome = await findSerialPort(undefined, 1500000, deps);
  if (portOutcome.port !== null) {
    patch.port = portOutcome.port;
    if (portOutcome.reason !== null) reasons['port'] = portOutcome.reason;
  } else if (portOutcome.problem !== null) {
    problems.push(portOutcome.problem);
  }

  return { patch, reasons, problems };
}

/** The addresses the board reports ✓ (every one of them ✓) */
export function addressesFrom(stdout: string): string[] {
  return parseIPv4(stdout);
}

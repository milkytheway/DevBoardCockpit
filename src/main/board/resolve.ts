/**
 * **Filling the machine-specific values of a connection profile.**
 *
 * ── The problem this solves ──
 *
 * A shipped profile cannot carry the values that belong to **one machine and
 * one board** (the board's serial number ✓ · its address ✓ · the serial port
 * its console is on ✓). The publishing step replaced them with placeholders
 * (`192.0.2.100` ✓ · `0000000000000000` ✓) → **the shipped connections
 * pointed nowhere** ✓ → the user saw three identical failures ✓.
 *
 * → The values are **detected** ✓ and written into the **user directory** ✓
 *   (the user's copy overrides the built-in one ✓ — `profiles/loader.ts` ✓).
 *
 * ── What is detected and what is not ──
 *
 * | Value | How | Why it is safe |
 * |---|---|---|
 * | **the adb serial** ✓ | `adb devices` ✓ | **Exactly one** board is in the `device` state ✓ → and it has to **say that it is this board** ✓ (`/proc/device-tree/model` ✓ · the board pack's match rules ✓) |
 * | **the board's address** ✓ | `adb -s <serial> shell ip -4 addr show` ✓ | The board reports its own address ✓ → **the loopback address is never used** ✓ |
 * | **the serial port** ✓ | the ports are **probed** ✓ | **Only a port that answers is the console** ✓ → **exactly one** answering port ✓ → otherwise it is the user's call ✓ |
 *
 * → **Several candidates → nothing is chosen** ✓ (the same rule as
 *   everywhere else in this project ✓ — "never guess" ✓).
 */
import type { ConnectionProfile } from '../profiles/schema';
import {
  isPlaceholderHost,
  listAdbDevices,
  readBoardIPv4,
  readBoardModel,
  probeSerialPorts,
  type AdbDevice,
  type AddressProbe,
  type DetectDeps,
  type PortProbe,
} from './detect';
import {
  candidatesOf,
  findCredential,
  type CredentialProbe,
} from './credential';
import type { SshRecords } from './ssh-records';

/** One value that was filled in ✓ */
export interface ProfileChange {
  /** Where the value lives (`options.serial` ✓ · `options.host` ✓ · …) */
  field: string;
  /** What it said before ✓ */
  from: string;
  /** What it says now ✓ */
  to: string;
  /** How it was found ✓ (the log line ✓) */
  how: string;
}

/** The result of the resolution ✓ */
export interface ResolveOutcome {
  /** The profile with the machine-specific values filled in ✓ */
  profile: ConnectionProfile;
  /** What was filled in ✓ */
  changes: ProfileChange[];
  /** What could not be filled in ✓ — **these become the error message** ✓ */
  problems: string[];
}

export interface ResolveDeps extends DetectDeps {
  /**
   * The models the board has to report ✓ (the board pack's match rules ✓).
   *
   * → **Empty means "no expectation"** ✓ → the only connected device is
   *   taken ✓ (and the model it reports is put into the log ✓).
   */
  expectedModels?: readonly string[];
  /** The serial ports of this machine ✓ (injected ✓ — the native module must not be dragged in here ✓) */
  ports?: PortProbe;
  /** The devices adb sees ✓ — **already fetched** ✓ (so the caller does not ask adb twice ✓) */
  devices?: readonly AdbDevice[];
  /**
   * **The SSH records of this machine** ✓ — the addresses the person already
   * reaches ✓ and the private keys they use ✓.
   *
   * → They are the authority for a machine that is **not a board** ✓ (the
   *   guest ✓ — it has an address of its own ✓) and the pool the credential
   *   is taken from ✓.
   */
  ssh?: SshRecords;
  /** **Does this key authenticate at this host?** ✓ (injected ✓ — the tests do not connect ✓) */
  probeCredential?: CredentialProbe;
  /** **Does this address answer?** ✓ (injected ✓) */
  probeAddress?: AddressProbe;
  /**
   * The host that **did not answer** ✓ — already measured ✓.
   *
   * → It is handed in so that the same host is not probed twice ✓ (a host
   *   that does not answer costs the whole timeout ✓).
   */
  deadHost?: string | null;
}

/** Does the model the board reports match what the board pack expects? */
export function modelMatches(model: string, expected: readonly string[]): boolean {
  if (expected.length === 0) return true;
  const target = model.toLowerCase();
  return expected.some((candidate) => target.includes(candidate.toLowerCase()));
}

/** The string value of an option ✓ */
function optionString(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The serial of the board, detected ✓.
 *
 * → The pinned serial is used when it is really there ✓.
 * → Otherwise: **exactly one** board in the `device` state ✓ → and it has
 *   to be **this board** ✓ (the model it reports ✓) → otherwise nothing is
 *   chosen ✓.
 */
async function detectAdbSerial(
  options: Record<string, unknown>,
  deps: ResolveDeps,
  problems: string[],
): Promise<{ serial: string | null; change: ProfileChange | null }> {
  const pinned = optionString(options, 'serial');
  const devices = deps.devices ?? (await listAdbDevices(deps));
  const ready = devices.filter((device) => device.state === 'device');

  // ── The pinned serial is really there → it is the board ✓ ──
  if (pinned !== undefined && devices.some((device) => device.serial === pinned)) {
    return { serial: pinned, change: null };
  }

  if (ready.length === 0) {
    problems.push(
      devices.length === 0
        ? 'adb sees no board (is the USB cable plugged in?)'
        : `adb sees no board in the "device" state (${devices
            .map((device) => `${device.serial}: ${device.stateText}`)
            .join(', ')})`,
    );
    return { serial: null, change: null };
  }

  if (ready.length > 1) {
    problems.push(
      `adb sees ${ready.length} boards (${ready
        .map((device) => device.serial)
        .join(', ')}) — the board setup has to say which one this is`,
    );
    return { serial: null, change: null };
  }

  // ── Exactly one board ✓ → it has to be **this** board ✓ ──
  const only = ready[0];
  if (only === undefined) return { serial: null, change: null };
  const model = await readBoardModel(only.serial, deps);
  const expected = deps.expectedModels ?? [];
  if (model !== null && !modelMatches(model, expected)) {
    problems.push(
      `the only board adb sees (${only.serial}) reports the model "${model}", which is not the model this connection is for (${expected.join(
        ' / ',
      )})`,
    );
    return { serial: null, change: null };
  }
  if (pinned !== undefined) {
    return {
      serial: only.serial,
      change: {
        field: 'options.serial',
        from: pinned,
        to: only.serial,
        how: model === null ? 'the only board adb sees' : `the only board adb sees (it reports "${model}")`,
      },
    };
  }
  return {
    serial: only.serial,
    change: {
      field: 'options.serial',
      from: '(not set)',
      to: only.serial,
      how: model === null ? 'the only board adb sees' : `the only board adb sees (it reports "${model}")`,
    },
  };
}

/**
 * The address of the board ✓ — read from the board itself ✓.
 *
 * → The loopback address is never it ✓ (`detect.ts` ✓).
 */
async function detectBoardAddress(
  serial: string | null,
  deps: ResolveDeps,
): Promise<string | null> {
  if (serial === null) return null;
  return readBoardIPv4(serial, deps);
}

/**
 * **The address of a machine that is not a board** ✓ — the guest ✓.
 *
 * → **It comes from the person's own records** ✓ (`~/.ssh/known_hosts` ✓ ·
 *   `~/.ssh/config` ✓) → **the board's address never leaks into it** ✓
 *   (the same rule as everywhere else ✓).
 * → **Exactly one address → it is used** ✓ · **several → the person says**
 *   ✓ (and the value that is there stays ✓ — it is the person's own ✓) ·
 *   **none → it is reported** ✓.
 */
function resolveMachineAddress(
  profile: ConnectionProfile,
  options: Record<string, unknown>,
  deps: ResolveDeps,
  changes: ProfileChange[],
  problems: string[],
): string | null {
  if (profile.transport !== 'ssh') return null;
  const records = deps.ssh?.addresses ?? [];
  const current = optionString(options, 'host');

  if (records.length === 0) {
    if (current !== undefined && !isPlaceholderHost(current)) return current;
    problems.push(
      'this machine has no ssh records (no ~/.ssh/known_hosts, no ~/.ssh/config) — the address of this machine has to be said',
    );
    return null;
  }

  if (records.length > 1) {
    // → **Several candidates → the person says which one** ✓ (rule 17 ✓)
    if (current !== undefined && records.includes(current)) return current;
    problems.push(
      `this machine knows ${records.length} ssh addresses (${records.join(' / ')}) — the board setup has to say which one this connection is`,
    );
    return current ?? null;
  }

  const address = records[0] ?? '';
  if (address.length === 0) return null;
  if (current === address) return address;
  options['host'] = address;
  changes.push({
    field: 'options.host',
    from: current ?? '(not set)',
    to: address,
    how: 'the address this machine reaches over ssh (the known hosts of this machine)',
  });
  return address;
}

/**
 * **The credential of an ssh connection** ✓.
 *
 * → A profile that names one keeps it ✓ (the person's own choice ✓).
 * → Otherwise the **keys of this machine** are tried ✓ and the one that
 *   **authenticates** is the credential ✓ (a measurement ✓ · never a guess
 *   ✓).
 * → **No key authenticates** → the profile keeps no credential ✓ and the
 *   connection says that the host **answered but refused** ✓ (a different
 *   problem than "the host does not answer" ✓ — the fix is different ✓).
 */
async function resolveCredential(
  profile: ConnectionProfile,
  options: Record<string, unknown>,
  deps: ResolveDeps,
  changes: ProfileChange[],
  problems: string[],
): Promise<void> {
  if (profile.transport !== 'ssh') return;
  const named = optionString(options, 'key_filename');
  const password = optionString(options, 'password');
  if (named !== undefined || password !== undefined) return;

  const host = optionString(options, 'host');
  if (host === undefined) return;
  const port = Number(options['port'] ?? 22);
  const username = optionString(options, 'username') ?? '';
  if (username.length === 0) return;

  // → **A host that does not answer is not tried** ✓ — the handshake against
  //   it would wait for the whole timeout ✓ (8 seconds ✓) and it could not
  //   succeed anyway ✓ (there is nobody there ✓).
  if (deps.deadHost === host) {
    problems.push(`the SSH host ${host} does not answer — the credential cannot be tried`);
    return;
  }

  const candidates = candidatesOf(deps.ssh?.keys ?? []);
  if (candidates.length === 0) {
    problems.push(
      'this machine has no ssh private key (nothing in ~/.ssh) — the credential has to be said',
    );
    return;
  }
  if (deps.probeCredential === undefined) return;

  const found = await findCredential({ host, port, username }, candidates, deps.probeCredential);
  if (found === null) {
    problems.push(
      `none of the ${candidates.length} private keys of this machine authenticates at ${host} as ${username}`,
    );
    return;
  }
  options['key_filename'] = found.candidate.path;
  changes.push({
    field: 'options.key_filename',
    from: '(not set)',
    to: found.candidate.path,
    how: 'the key of this machine that authenticates at this host',
  });
}

/**
 * Fill the machine-specific values of one profile ✓.
 *
 * → **Nothing is written to the disk here** ✓ (that is `persistProfile` ✓) —
 *   this function only decides ✓.
 */
export async function resolveProfile(
  profile: ConnectionProfile,
  deps: ResolveDeps = {},
): Promise<ResolveOutcome> {
  const options: Record<string, unknown> = { ...profile.options };
  const changes: ProfileChange[] = [];
  const problems: string[] = [];

  // → **A connection without a board pack is not a board's connection** ✓
  //   (the host's own shell ✓ · **the guest machine** ✓) → it must never get
  //   the board's address ✓ → **the adb detection is not its business** ✓
  //   (the guest is not on adb ✓ · asking adb about it is nonsense ✓).
  const isBoard = typeof profile.board_pack === 'string' && profile.board_pack.length > 0;

  // ── The adb serial ✓ (needed for the address too ✓) ──
  let serial: string | null = null;
  if (isBoard) {
    const serialOutcome = await detectAdbSerial(options, deps, problems);
    // → **Only the adb connection carries a serial** ✓ — the other two would
    //   get a field they never read ✗ (a field nobody reads is a lie about
    //   what the connection is ✓).
    if (serialOutcome.change !== null && profile.transport === 'adb') {
      changes.push(serialOutcome.change);
      options['serial'] = serialOutcome.change.to;
    }
    serial = serialOutcome.serial;
  }

  // ── The address ✓ ──
  // → **A machine that is not a board** ✓ (the guest ✓) → its address is the
  //   person's own ✓ (the ssh records ✓) → **the board's address never leaks
  //   into it** ✓.
  const address = isBoard
    ? await detectBoardAddress(serial, deps)
    : resolveMachineAddress(profile, options, deps, changes, problems);

  if (address !== null) {
    const host = optionString(options, 'host');
    // → **A stored address that does not answer is replaced** ✓ → the freeze
    //   of a connection is broken ✓ (a plausible but wrong address was
    //   invisible to the "is it a placeholder" check ✓).
    const dead = deps.deadHost ?? null;
    const broken =
      host !== undefined &&
      (isPlaceholderHost(host) || (dead !== null && dead === host));
    if (broken) {
      options['host'] = address;
      changes.push({
        field: 'options.host',
        from: host ?? '(not set)',
        to: address,
        how: isBoard
          ? 'the address the board reports about itself'
          : 'the address this machine reaches over ssh',
      });
    }
    const nested = options['ssh'];
    if (typeof nested === 'object' && nested !== null) {
      const ssh = { ...(nested as Record<string, unknown>) };
      const nestedHost = optionString(ssh, 'host');
      if (nestedHost !== undefined && isPlaceholderHost(nestedHost)) {
        ssh['host'] = address;
        options['ssh'] = ssh;
        changes.push({
          field: 'options.ssh.host',
          from: nestedHost,
          to: address,
          how: 'the address the board reports about itself',
        });
      }
    }
  }

  // ── The credential ✓ (the ssh transport only ✓) ──
  // → A profile that names one keeps it ✓ → otherwise the key of this
  //   machine that **authenticates** is taken ✓ (a measurement ✓).
  await resolveCredential(profile, options, deps, changes, problems);

  // ── The serial port ✓ (only when it is asked for ✓) ──
  // → The probe **opens the ports** ✓ → it is not done on every connection
  //   (that would be slow and it would poke at devices that are none of our
  //   business ✓) → the setup page and the "the port said nothing" path ask
  //   for it ✓.
  if (deps.ports !== undefined && profile.transport === 'serial') {
    const baud = Number(options['baudrate'] ?? 1500000);
    const current = optionString(options, 'port');
    const all = await deps.ports.list();

    // → **The configured port is asked first** ✓ (it is the one the profile
    //   names ✓) → **it is only one port** ✓ (the other ports are only
    //   opened when it stays silent ✓ — opening ports that belong to other
    //   devices is none of our business ✓).
    let state: 'answered' | 'silent' | 'busy' | 'unknown' = 'unknown';
    if (current !== undefined) {
      const one = await probeSerialPorts(
        all.filter((port) => port.path === current),
        baud,
        deps.ports,
      );
      if (one.answering.includes(current)) state = 'answered';
      else if (one.busy.includes(current)) state = 'busy';
      else state = 'silent';
    }

    if (state === 'answered' || state === 'busy') {
      // → **The port answers** ✓ → it is the board's console ✓ → nothing to
      //   change ✓.
      // → **The port is busy** ✓ (another program holds it ✓ — the runtime's
      //   own connection ✓) → **it is not "silent"** ✓ → the honest error is
      //   "the port is busy" ✓ → **the application must not look for
      //   another port** ✓.
    } else {
      const others = await probeSerialPorts(
        all.filter((port) => port.path !== current),
        baud,
        deps.ports,
      );
      if (others.answering.length === 1) {
        const found = others.answering[0] ?? '';
        if (found.length > 0 && found !== current) {
          options['port'] = found;
          changes.push({
            field: 'options.port',
            from: current ?? '(not set)',
            to: found,
            how: 'the only serial port that answered',
          });
        }
      } else if (others.answering.length > 1) {
        problems.push(
          `${others.answering.length} serial ports answered (${others.answering.join(', ')}) — the board setup has to say which one is the console`,
        );
      } else {
        problems.push(
          'no serial port answered — the console of the board is not connected (or the baud rate is wrong)',
        );
      }
    }
  }

  const resolved: ConnectionProfile = { ...profile, options };
  return { profile: resolved, changes, problems };
}

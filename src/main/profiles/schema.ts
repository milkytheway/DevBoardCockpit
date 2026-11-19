import { makeError } from '../../shared/errors';

/**
 * The schema of a connection profile (target).
 *
 * One profile describes one connection instance: whom it connects to, over
 * which transport, with which parameters. It is a different thing from a
 * board pack — the board pack says "what this board has", the profile says
 * "how to connect to it" (contract `docs/spec/02-board-pack.md` §10).
 *
 * A closed schema: an unknown field is always an error. Silently ignoring a
 * misspelled field is dangerous — a misspelled `board_pack` leaves the
 * connection bound to no board at all, and the user sees no hint of it.
 */

export type { TransportKind } from '../../shared/ipc-contract';
import type { TransportKind } from '../../shared/ipc-contract';

export interface ConnectionProfile {
  id: string;
  label: string;
  transport: TransportKind;
  /** The bound board pack id (the key name in the terms of the contract). null / absent = no binding */
  board_pack?: string | null;
  /**
   * The identity of this board (contract `spec/02` §10.2 ✓).
   *
   * → The physical board and the connection are two layers ✓ — one board has
   *   three connections: ADB / serial / SSH ✓
   * → Several connections of the same board write the same `device_key` ✓
   * → Absent = `id` ✓ (a connection with one board and one connection is
   *   done that way ✓).
   *
   * → Always read the value through `deviceKeyOf()` ✓ — do not read this
   *   field directly ✓ (a hand-written profile does not have it ✓ → reading
   *   it directly yields `undefined` ✗).
   */
  device_key?: string;
  options: Record<string, unknown>;
}

/**
 * Which board this connection belongs to ✓.
 *
 * → Absent = the profile id ✓ (contract `spec/02` §10.2 ✓)
 * → This is the one place the value is read ✓ — reading `profile.device_key`
 *   anywhere else ✗ (it may be `undefined` ✗).
 */
export function deviceKeyOf(profile: ConnectionProfile): string {
  return profile.device_key !== undefined && profile.device_key.length > 0
    ? profile.device_key
    : profile.id;
}

/** A conflict on one `device_key` (say exactly which ones ✓) */
export interface DeviceKeyConflict {
  /** The key that conflicts ✓ */
  device_key: string;
  /** Which board packs are declared (more than one is a conflict ✓) */
  board_packs: string[];
  /** Which profiles are involved ✓ */
  profile_ids: string[];
}

/**
 * The same `device_key` declares different board packs ✓ (contract
 * `spec/02` §10.2 ✓).
 *
 * → One board has only one model ✓ → the same key declares two packs ✗ →
 *   the configuration is wrong ✓
 * → It has to be said out loud ✓ (never silent ✓ — the interface treats it
 *   as one board ✓ → the models get mixed up ✓).
 *
 * → Two boards of the same model are not a conflict ✓ (their keys differ ✓
 *   — they share one pack ✓ but they are not one board ✓).
 */
export function deviceKeyConflicts(
  profiles: readonly ConnectionProfile[],
): DeviceKeyConflict[] {
  const byKey = new Map<string, { packs: Set<string>; ids: string[] }>();
  for (const profile of profiles) {
    const key = deviceKeyOf(profile);
    const entry = byKey.get(key) ?? { packs: new Set<string>(), ids: [] };
    entry.packs.add(profile.board_pack ?? '');
    entry.ids.push(profile.id);
    byKey.set(key, entry);
  }
  const out: DeviceKeyConflict[] = [];
  for (const [key, entry] of byKey) {
    if (entry.packs.size <= 1) continue;
    out.push({
      device_key: key,
      board_packs: [...entry.packs].sort(),
      profile_ids: entry.ids,
    });
  }
  return out;
}

/** The options each transport allows. The required ones have to be there, the rest are optional. */
interface TransportSpec {
  required: readonly string[];
  optional: readonly string[];
  defaults?: Record<string, unknown>;
}

/**
 * The optional fields shared by all transports.
 *
 * - `pty`: is the target a real terminal (the capability bit is decided by
 *   the profile, not guessed from the transport name)
 * - `prompt`: the prompt the host has to draw in pipe mode. The remote side
 *   in pipe mode has no tty, so `PS1` cannot be printed — the legacy project
 *   drew it on the host side (the architecture notes of the legacy PySide6
 *   project).
 * - `commands`: the id of a quick-command set (quick-command set in the
 *   legacy project). It is registered but not consumed yet — the
 *   quick-command panel belongs to M5. Until then it is a field that "looks
 *   supported", so it is spelled out here, so that nobody thinks changing it
 *   takes effect (plan-1 review, finding R-36).
 */
const COMMON_OPTIONAL = ['pty', 'prompt', 'commands'] as const;

/**
 * `options.ssh` — the SSH endpoint of the machine behind this connection
 * (contract `spec/02` §10.3 ✓).
 *
 * → It crosses transports ✓ — a board connected by ADB can also be
 *   connected by SSH ✓ — the same board ✓
 * → An action that crosses machines is started on the other machine ✓ →
 *   that command has to use the board's SSH address ✓
 * → A workflow pack should not know the board's address ✓ → it travels
 *   with the profile ✓.
 *
 * → Only for `serial` / `adb` ✓ —
 * → the `ssh` transport is that endpoint itself ✓ → writing it twice means
 *   drift ✓ → report an error ✓ (not "whoever wins" ✓ — never guess ✓)
 * → `local` is the host itself ✓ → there is no board behind it ✓.
 */
const SSH_FACT_OPTIONAL = ['ssh'] as const;

/** The closed field table of `options.ssh`. `host` is required. */
const SSH_FACT_KEYS = ['host', 'port', 'username'] as const;

const TRANSPORT_SPECS: Record<TransportKind, TransportSpec> = {
  serial: {
    required: ['port'],
    optional: ['baudrate', ...SSH_FACT_OPTIONAL, ...COMMON_OPTIONAL],
    defaults: { baudrate: 115200 },
  },
  adb: {
    required: [],
    optional: ['serial', ...SSH_FACT_OPTIONAL, ...COMMON_OPTIONAL],
  },
  ssh: {
    required: ['host'],
    optional: ['port', 'username', 'key_filename', 'password', ...COMMON_OPTIONAL],
    defaults: { port: 22 },
  },
  local: {
    required: [],
    optional: [...COMMON_OPTIONAL],
  },
};

const TOP_LEVEL_KEYS = [
  'id',
  'label',
  'transport',
  'board_pack',
  'device_key',
  'options',
] as const;
const TRANSPORTS = Object.keys(TRANSPORT_SPECS) as TransportKind[];

function fail(message: string, source: string, detail?: unknown): never {
  throw makeError('IPC_INVALID_PAYLOAD', message, {
    detail: { source, ...(detail !== undefined ? { detail } : {}) },
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validates and normalises one profile.
 * @param raw   The parsed JSON (must be an object)
 * @param source Where it came from (the file path), written into the detail of the error so that it can be located
 */
export function parseProfile(raw: unknown, source: string): ConnectionProfile {
  if (!isRecord(raw)) fail('profile 必须是一个对象', source);

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.includes(key as (typeof TOP_LEVEL_KEYS)[number])) {
      fail(`未知字段 '${key}'`, source, { key });
    }
  }

  const id = raw['id'];
  const label = raw['label'];
  const transport = raw['transport'];

  if (typeof id !== 'string' || id.length === 0) fail('id 必须是非空字符串', source);
  if (typeof label !== 'string' || label.length === 0) fail('label 必须是非空字符串', source);
  if (typeof transport !== 'string' || !TRANSPORTS.includes(transport as TransportKind)) {
    fail(`transport 必须是 ${TRANSPORTS.join(' / ')} 之一`, source, { transport });
  }

  const spec = TRANSPORT_SPECS[transport as TransportKind];
  const rawOptions = raw['options'];
  if (!isRecord(rawOptions)) fail('options 必须是一个对象', source);

  // A transport conflict on `options.ssh` ✓ — judged before the "unknown
  // field" check ✓
  // (otherwise the error says "unknown field 'ssh'" ✓ → that does not show
  // that it is a conflict and not a typo ✓)
  if (rawOptions['ssh'] !== undefined) {
    if (transport === 'ssh') {
      fail('options.ssh 不许带：这条连接自己就是那个 SSH 端点（双写会漂移）', source, {
        transport,
      });
    }
    if (transport === 'local') {
      fail('options.ssh 不许带：local 是宿主自己，没有背后的板子', source, { transport });
    }
  }

  for (const key of Object.keys(rawOptions)) {
    if (!spec.required.includes(key) && !spec.optional.includes(key)) {
      fail(`未知字段 '${key}'`, source, { key, transport });
    }
  }
  for (const key of spec.required) {
    if (rawOptions[key] === undefined) {
      fail(`缺少必填字段 '${key}'`, source, { key, transport });
    }
  }

  // The closed shape of `options.ssh` itself ✓
  const sshFact = rawOptions['ssh'];
  if (sshFact !== undefined) {
    if (!isRecord(sshFact)) fail('options.ssh 必须是一个对象', source);
    for (const key of Object.keys(sshFact)) {
      if (!SSH_FACT_KEYS.includes(key as (typeof SSH_FACT_KEYS)[number])) {
        fail(`未知字段 '${key}'`, source, { key, in: 'options.ssh' });
      }
    }
    const host = sshFact['host'];
    if (typeof host !== 'string' || host.length === 0) {
      fail('options.ssh 的 host 必填（非空字符串）', source);
    }
    if (sshFact['port'] !== undefined && typeof sshFact['port'] !== 'number') {
      fail('options.ssh 的 port 必须是数字', source);
    }
    if (sshFact['username'] !== undefined && typeof sshFact['username'] !== 'string') {
      fail('options.ssh 的 username 必须是字符串', source);
    }
  }

  // Fact A1: adb does not use a PTY (`adb shell -t -t` on Windows arrives one line late)
  if (transport === 'adb' && rawOptions['pty'] === true) {
    fail("adb 的 pty 必须是 false：adb shell -t -t 在 Windows 上会晚一条（事实 A1）", source);
  }

  const options: Record<string, unknown> = { ...spec.defaults, ...rawOptions };

  const boardPack = raw['board_pack'];
  if (boardPack !== undefined && boardPack !== null && typeof boardPack !== 'string') {
    fail('board_pack 必须是字符串或 null', source);
  }

  // `device_key` ✓ — absent = the profile id ✓
  const rawDeviceKey = raw['device_key'];
  if (
    rawDeviceKey !== undefined &&
    (typeof rawDeviceKey !== 'string' || rawDeviceKey.length === 0)
  ) {
    fail('device_key 必须是非空字符串', source);
  }
  const deviceKey = rawDeviceKey !== undefined ? (rawDeviceKey as string) : id;

  return {
    id,
    label,
    transport: transport as TransportKind,
    ...(boardPack !== undefined ? { board_pack: boardPack as string | null } : {}),
    device_key: deviceKey,
    options,
  };
}

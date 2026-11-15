import { makeError } from '../../shared/errors';

/**
 * 连接 profile（target）的 schema。
 *
 * 一份 profile 描述**一个连接实例**：连谁、用什么传输、参数是什么。
 * 它和板型包（board pack）是两样东西——板型包说「这块板有什么」，
 * profile 说「怎么连上它」（契约 `docs/spec/02-board-pack.md` §10）。
 *
 * **封闭 schema**：未知字段一律报错。静默忽略拼错的字段是危险的——
 * 拼错的 `board_pack` 会让连接绑不上任何板，而用户看不到任何提示。
 */

export type { TransportKind } from '../../shared/ipc-contract';
import type { TransportKind } from '../../shared/ipc-contract';

export interface ConnectionProfile {
  id: string;
  label: string;
  transport: TransportKind;
  /** 绑定的板型包 id（契约口径的键名）。null / 缺省 = 不绑 */
  board_pack?: string | null;
  /**
   * **这块板的标识**（契约 `spec/02` §10.2 ✓）。
   *
   * → **板实物**与**连接**是两层 ✓ —— 一块板有 ADB / 串口 / SSH 三条连接 ✓
   * → **同一块板的多条连接写同一个 `device_key`** ✓
   * → 缺省 = `id` ✓（**一板一连** ✓ 的连接就这么办 ✓）。
   *
   * → **取值一律走 `deviceKeyOf()`** ✓ —— **别直接读这个字段** ✓
   *   （手搓的 profile 没有它 ✓ → 直接读会拿到 `undefined` ✗）。
   */
  device_key?: string;
  options: Record<string, unknown>;
}

/**
 * **这条连接属于哪块板** ✓。
 *
 * → **缺省 = profile id** ✓（契约 `spec/02` §10.2 ✓）
 * → **这是取值的唯一入口** ✓ —— 别处直接读 `profile.device_key` ✗（可能是 `undefined` ✗）。
 */
export function deviceKeyOf(profile: ConnectionProfile): string {
  return profile.device_key !== undefined && profile.device_key.length > 0
    ? profile.device_key
    : profile.id;
}

/** 各传输允许的 options。必填项必须有，其余可选。 */
interface TransportSpec {
  required: readonly string[];
  optional: readonly string[];
  defaults?: Record<string, unknown>;
}

/**
 * 各传输共有的可选字段。
 *
 * - `pty`：目标是不是真终端（能力位由 profile 决定，不靠传输名猜）
 * - `prompt`：**pipe 模式下宿主要画的提示符**。
 *   pipe 模式的远端没有 tty，`PS1` 无从打印——前身工程就是宿主画的
 *   （`docs/legacy/旧工程架构说明-PySide6.md`）。
 * - `commands`：**快捷命令集的 id**（前身工程：quick-command set）。
 *   **已登记但尚未消费**——快捷命令面板属 M5。
 *   在那之前它是一个「看起来支持」的字段，所以在这里写清楚，
 *   免得有人以为改它能生效（`docs/11-计划1评审报告.md` R-36）。
 */
const COMMON_OPTIONAL = ['pty', 'prompt', 'commands'] as const;

/**
 * **`options.ssh`** —— **这条连接背后那台机器**的 SSH 端点（契约 `spec/02` §10.3 ✓）。
 *
 * → **它跨传输** ✓ —— ADB 连的板子也能被 SSH 连 ✓ —— 同一块板 ✓
 * → **跨机器的动作在另一台机器上发起** ✓ → 那条命令要用**板子的 SSH 地址** ✓
 * → **流程包不该知道板子的地址** ✓ → **它跟着 profile 走** ✓。
 *
 * → **只给 `serial` / `adb`** ✓ ——
 * → `ssh` 传输**自己就是那个端点** ✓ → 双写 = 漂移 ✓ → **报错** ✓（不是「谁赢」✓ —— **不猜** ✓）
 * → `local` 是**宿主自己** ✓ → 没有背后的板子 ✓。
 */
const SSH_FACT_OPTIONAL = ['ssh'] as const;

/** `options.ssh` 的封闭字段表。`host` 必填。 */
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
 * 校验并规范化一份 profile。
 * @param raw   解析好的 JSON（必须是对象）
 * @param source 出处（文件路径），写进错误的 detail 里便于定位
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

  // **`options.ssh` 的传输冲突** ✓ —— **先于「未知字段」判** ✓
  // （否则报的是「未知字段 'ssh'」✓ → 看不出那是**冲突**而不是拼错 ✓）
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

  // **`options.ssh` 自己的封闭形状** ✓
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

  // 事实 A1：adb 不用 PTY（`adb shell -t -t` 在 Windows 上会晚一条）
  if (transport === 'adb' && rawOptions['pty'] === true) {
    fail("adb 的 pty 必须是 false：adb shell -t -t 在 Windows 上会晚一条（事实 A1）", source);
  }

  const options: Record<string, unknown> = { ...spec.defaults, ...rawOptions };

  const boardPack = raw['board_pack'];
  if (boardPack !== undefined && boardPack !== null && typeof boardPack !== 'string') {
    fail('board_pack 必须是字符串或 null', source);
  }

  // **`device_key`** ✓ —— 缺省 = profile id ✓
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

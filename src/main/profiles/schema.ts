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
  options: Record<string, unknown>;
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

const TRANSPORT_SPECS: Record<TransportKind, TransportSpec> = {
  serial: {
    required: ['port'],
    optional: ['baudrate', ...COMMON_OPTIONAL],
    defaults: { baudrate: 115200 },
  },
  adb: {
    required: [],
    optional: ['serial', ...COMMON_OPTIONAL],
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

const TOP_LEVEL_KEYS = ['id', 'label', 'transport', 'board_pack', 'options'] as const;
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

  // 事实 A1：adb 不用 PTY（`adb shell -t -t` 在 Windows 上会晚一条）
  if (transport === 'adb' && rawOptions['pty'] === true) {
    fail("adb 的 pty 必须是 false：adb shell -t -t 在 Windows 上会晚一条（事实 A1）", source);
  }

  const options: Record<string, unknown> = { ...spec.defaults, ...rawOptions };

  const boardPack = raw['board_pack'];
  if (boardPack !== undefined && boardPack !== null && typeof boardPack !== 'string') {
    fail('board_pack 必须是字符串或 null', source);
  }

  return {
    id,
    label,
    transport: transport as TransportKind,
    ...(boardPack !== undefined ? { board_pack: boardPack as string | null } : {}),
    options,
  };
}

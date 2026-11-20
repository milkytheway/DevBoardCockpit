import type { ConnectionInfo } from '../../shared/ipc-contract';
import type { RuntimeStatus } from '../../shared/runtime-status';
import { pick, type Locale, type Localised } from './i18n';

/**
 * The shell's wording helpers.
 *
 * ── There is **no** formatting of readings here ──
 *
 * A reading is rendered by **the card itself** (the card receives the raw
 * reading and its state), so the shell needs no code for "how a reading
 * should look".
 * (There used to be a `readingMeta` / `readingValueText` pair — their
 * semantics did not even match the wildcard rules on the main side, and
 * only the tests used them: **a green suite proves nothing about the
 * product**.)
 */

export type ReadingTone = 'ok' | 'warn' | 'danger' | 'unknown' | 'muted';

/**
 * The wording of this module, in both languages.
 *
 * These helpers are data, not components: they cannot read the React
 * context, so they hand back a localised pair and the caller resolves it
 * where it is drawn.
 */
const strings = {
  serial: { 'zh-Hans': '串口', en: 'Serial' },
  local: { 'zh-Hans': '本机', en: 'Local' },
  unbound: { 'zh-Hans': '未绑定连接', en: 'No connection bound' },
  sampling: { 'zh-Hans': '采样中', en: 'Sampling' },
  noPack: { 'zh-Hans': '未识别板型', en: 'Board pack not recognised' },
  failed: { 'zh-Hans': '连接失败', en: 'Connection failed' },
  idle: { 'zh-Hans': '空闲', en: 'Idle' },
  notStarted: { 'zh-Hans': '未开始采样', en: 'Sampling has not started' },
  unknownError: { 'zh-Hans': '未知错误', en: 'Unknown error' },
} satisfies Record<string, Localised>;

/** A word that is the same in both languages. */
function both(text: string): Localised {
  return { 'zh-Hans': text, en: text };
}

export function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

export function transportLabel(transport: ConnectionInfo['transport']): Localised {
  switch (transport) {
    case 'serial':
      return strings.serial;
    case 'adb':
      return both('ADB');
    case 'ssh':
      return both('SSH');
    case 'local':
      return strings.local;
    default:
      return both(transport);
  }
}

export interface RuntimeText {
  tone: ReadingTone;
  label: Localised;
  detail: Localised;
}

export function runtimeText(status: RuntimeStatus, connections: ConnectionInfo[]): RuntimeText {
  const profile = connections.find((c) => c.id === status.profileId);
  const target: Localised = profile
    ? both(profile.label)
    : status.profileId !== undefined
      ? both(status.profileId)
      : strings.unbound;
  const detail = status.detail !== undefined ? both(status.detail) : target;
  switch (status.state) {
    case 'running':
      return { tone: 'ok', label: strings.sampling, detail: target };
    case 'no-pack':
      return { tone: 'warn', label: strings.noPack, detail };
    case 'error':
      return { tone: 'danger', label: strings.failed, detail };
    case 'idle':
    default:
      return { tone: 'muted', label: strings.idle, detail: status.detail !== undefined ? detail : strings.notStarted };
  }
}

export function capabilitiesText(info: ConnectionInfo | undefined): string {
  if (!info) return '';
  const caps = info.capabilities;
  return [
    caps.exec ? 'exec' : null,
    caps.pty ? 'pty' : null,
    caps.files ? 'files' : null,
    caps.exitCode ? 'exit-code' : null,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ');
}

/** Turn an unknown rejection into a sentence a engineer can act on. */
export function describeError(cause: unknown, locale: Locale): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return pick(strings.unknownError, locale);
  }
}

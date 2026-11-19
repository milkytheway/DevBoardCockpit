import type { ConnectionInfo } from '../../shared/ipc-contract';
import type { RuntimeStatus } from '../../shared/runtime-status';
import { pick, type Locale, type Localised } from './i18n';

/**
 * The shell's wording helpers.
 *
 * ── 这里**没有**读数的格式化 ──
 *
 * 读数由**卡片自己**渲染（卡片拿到的是原始读数与五态），
 * 所以外壳这边不需要「把读数画成什么样」的代码。
 * （曾经有过一份 `readingMeta` / `readingValueText`——
 * 它们的语义还和 main 那边的通配符规则对不上，
 * 而且只被测试用着：**绿的套件证明不了产品**。）
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

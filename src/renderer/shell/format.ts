import type { ConnectionInfo } from '../../shared/ipc-contract';
import type { RuntimeStatus } from '../../shared/runtime-status';

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

export function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

export function transportLabel(transport: ConnectionInfo['transport']): string {
  switch (transport) {
    case 'serial':
      return '串口';
    case 'adb':
      return 'ADB';
    case 'ssh':
      return 'SSH';
    case 'local':
      return '本机';
    default:
      return transport;
  }
}

export interface RuntimeText {
  tone: ReadingTone;
  label: string;
  detail: string;
}

export function runtimeText(status: RuntimeStatus, connections: ConnectionInfo[]): RuntimeText {
  const profile = connections.find((c) => c.id === status.profileId);
  const target = profile ? profile.label : (status.profileId ?? '未绑定连接');
  switch (status.state) {
    case 'running':
      return { tone: 'ok', label: '采样中', detail: target };
    case 'no-pack':
      return { tone: 'warn', label: '未识别板型', detail: status.detail ?? target };
    case 'error':
      return { tone: 'danger', label: '连接失败', detail: status.detail ?? target };
    case 'idle':
    default:
      return { tone: 'muted', label: '空闲', detail: status.detail ?? '未开始采样' };
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
export function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return '未知错误';
  }
}

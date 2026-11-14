import type { ConnectionInfo } from '../../shared/ipc-contract';
import type { TagReading } from '../../shared/tag-reading';
import type { RuntimeStatus } from '../../shared/runtime-status';

export type ReadingTone = 'ok' | 'warn' | 'danger' | 'unknown' | 'muted';

export interface ReadingMeta {
  /** Shape channel: the status must be readable without colour. */
  glyph: string;
  label: string;
  tone: ReadingTone;
  /** Whether the value is trustworthy enough to render. */
  showValue: boolean;
  detail: string;
}

const REASON_TEXT: Record<string, string> = {
  not_found: '板型包未提供该 tag',
  device_absent: '设备不在',
  service_down: '服务未运行',
  link_busy_terminal: '链路被终端占用',
  parse_error: '读数解析失败',
  out_of_domain: '超出量程',
  timeout: '读取超时',
};

/** Contract five states plus the shell's pending/unavailable wording. */
export function readingMeta(reading: TagReading | undefined): ReadingMeta {
  if (!reading) {
    return {
      glyph: '⊘',
      label: '不可用',
      tone: 'unknown',
      showValue: false,
      detail: '还没有读数',
    };
  }
  switch (reading.status) {
    case 'ok':
      return { glyph: '●', label: '实时', tone: 'ok', showValue: true, detail: '' };
    case 'pending':
      return {
        glyph: '◌',
        label: '等待首个采样',
        tone: 'muted',
        showValue: false,
        detail: 'pending',
      };
    case 'stale':
      return {
        glyph: '◐',
        label: '已过时',
        tone: 'warn',
        showValue: true,
        detail: reading.detail ?? '最后 ' + ageText(reading.at),
      };
    case 'error':
      return {
        glyph: '✕',
        label: '读取失败',
        tone: 'danger',
        showValue: reading.value !== null,
        detail: reading.detail ?? REASON_TEXT[reading.reason ?? ''] ?? '读取失败',
      };
    case 'unavailable':
    default:
      return {
        glyph: '⊘',
        label: '不可用',
        tone: 'unknown',
        showValue: false,
        detail: reading.detail ?? REASON_TEXT[reading.reason ?? ''] ?? '板型包未提供该 tag',
      };
  }
}

export interface ValueText {
  value: string;
  unit: string;
}

/**
 * The contract stores machine units (`percent`, `hertz`, `bytes`…); the shell
 * shows the symbol an engineer expects. Keep the mapping in one place so the
 * readings card, the inspector and the cards' footer agree.
 */
function displayUnit(raw: string): string {
  switch (raw) {
    case 'percent':
      return '%';
    case 'hertz':
      return 'Hz';
    case 'celsius':
      return '°C';
    case 'bytes':
      return 'B';
    case 'volt':
      return 'V';
    case 'millivolt':
      return 'mV';
    case 'milliampere':
      return 'mA';
    default:
      return raw;
  }
}

/** Numbers keep the contract's precision rules: no zero padding, unit one level down. */
export function readingValueText(reading: TagReading | undefined): ValueText {
  if (!reading || reading.value === null) {
    return { value: '—', unit: displayUnit(reading?.unit ?? '') };
  }
  const unit = displayUnit(reading.unit ?? '');
  if (typeof reading.value === 'boolean') return { value: reading.value ? '开' : '关', unit: '' };
  if (typeof reading.value === 'string') return { value: reading.value, unit };
  const n = reading.value;
  if (unit === 'Hz') {
    if (Math.abs(n) >= 1e9) return { value: (n / 1e9).toFixed(2), unit: 'GHz' };
    const mhz = n / 1e6;
    return { value: mhz.toFixed(mhz >= 100 ? 0 : mhz >= 10 ? 1 : 2), unit: 'MHz' };
  }
  if (unit === '°C' || unit === '℃') return { value: n.toFixed(1), unit: '°C' };
  if (unit === 'B') {
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = n;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return { value: index === 0 ? String(Math.round(value)) : value.toFixed(1), unit: units[index] };
  }
  if (!Number.isFinite(n)) return { value: '—', unit };
  if (Math.abs(n) >= 1000) {
    return { value: n.toLocaleString('en-US', { maximumFractionDigits: 0 }), unit };
  }
  if (Number.isInteger(n)) return { value: String(n), unit };
  return { value: n.toFixed(1), unit };
}

export function ageText(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 2) return '刚刚';
  if (seconds < 60) return seconds + ' 秒前';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + ' 分钟前';
  const hours = Math.round(minutes / 60);
  return hours + ' 小时前';
}

export function clockText(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

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

/** Local ring buffer used by the sparklines. */
export function pushHistory(map: Map<string, number[]>, tag: string, value: number, limit = 60): void {
  const next = map.get(tag) ?? [];
  next.push(value);
  if (next.length > limit) next.splice(0, next.length - limit);
  map.set(tag, next);
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

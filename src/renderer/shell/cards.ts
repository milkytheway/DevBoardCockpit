/**
 * Display metadata for the cards the host knows about.
 *
 * The host never inspects a card's internals — the manifest only carries the
 * machine identity (`cpu-usage`). This module turns that id into the words
 * and the pictogram the shell draws in its chrome, the detail panel and the
 * card library. An unknown card falls back to its raw id, so a card the AI
 * just wrote still looks intentional.
 */
import type { Localised } from './i18n';

export type CardTone = 'blue' | 'violet' | 'green' | 'amber' | 'cyan' | 'rose' | 'slate';

/** The sidebar buckets, in display order. */
export const CARD_GROUPS = [
  { 'zh-Hans': '性能', en: 'Performance' },
  { 'zh-Hans': '内存与温度', en: 'Memory and temperature' },
  { 'zh-Hans': '系统', en: 'System' },
  { 'zh-Hans': '自定义', en: 'Custom' },
] as const satisfies readonly Localised[];
export type CardGroup = Localised;

export interface CardLook {
  /** Human name shown in the card chrome. */
  name: Localised;
  /** One line: what the card is for. */
  note: Localised;
  /** Icon family drawn by the shell. */
  icon: 'cpu' | 'gpu' | 'memory' | 'thermal' | 'board' | 'activity' | 'bolt';
  /** Accent used for the icon tile and the card's left edge. */
  tone: CardTone;
  /** Which sidebar bucket the card belongs to. */
  group: Localised;
  /**
   * The tags this card is expected to read.
   *
   * The renderer cannot read a card's manifest (the card lives in an opaque
   * iframe, and the host does not expose manifests over IPC). This list is
   * display metadata for the built-in cards only; an unknown card shows an
   * honest "the host does not disclose its tag list" note in the detail panel.
   */
  tags: string[];
}

const LOOKS: Record<string, CardLook> = {
  'cpu-usage': {
    name: { 'zh-Hans': 'CPU 占用', en: 'CPU usage' },
    note: { 'zh-Hans': '总占用 · 8 核分布', en: 'Total usage · across 8 cores' },
    icon: 'cpu',
    tone: 'blue',
    group: { 'zh-Hans': '性能', en: 'Performance' },
    tags: ['cpu.usage', 'cpu.governor'],
  },
  'core-load': {
    name: { 'zh-Hans': '核心负载', en: 'Core load' },
    note: { 'zh-Hans': 'A55 / A76 逐核负载', en: 'Per-core load on A55 / A76' },
    icon: 'activity',
    tone: 'cyan',
    group: { 'zh-Hans': '性能', en: 'Performance' },
    tags: ['cpu.usage', 'cpu.core.*.usage', 'cpu.core.*.cluster'],
  },
  'gpu-npu': {
    name: { 'zh-Hans': 'GPU / NPU', en: 'GPU / NPU' },
    note: { 'zh-Hans': '负载 · 频率 · 温度', en: 'Load · frequency · temperature' },
    icon: 'gpu',
    tone: 'violet',
    group: { 'zh-Hans': '性能', en: 'Performance' },
    tags: ['gpu.usage', 'gpu.freq_hz', 'npu.usage', 'temp.gpu', 'temp.npu'],
  },
  memory: {
    name: { 'zh-Hans': '内存', en: 'Memory' },
    note: { 'zh-Hans': '已用 / 可用 · 采样趋势', en: 'Used / available · sampled over time' },
    icon: 'memory',
    tone: 'green',
    group: { 'zh-Hans': '内存与温度', en: 'Memory and temperature' },
    tags: ['mem.usage', 'mem.used_bytes', 'mem.total_bytes', 'mem.available_bytes'],
  },
  thermal: {
    name: { 'zh-Hans': '温度', en: 'Temperature' },
    note: { 'zh-Hans': 'SoC / GPU / NPU 温区', en: 'SoC / GPU / NPU zones' },
    icon: 'thermal',
    tone: 'amber',
    group: { 'zh-Hans': '内存与温度', en: 'Memory and temperature' },
    tags: ['temp.soc', 'temp.gpu', 'temp.npu'],
  },
  'board-identity': {
    name: { 'zh-Hans': '板卡身份', en: 'Board identity' },
    note: { 'zh-Hans': '型号 · 调频 · 频率', en: 'Model · governor · frequency' },
    icon: 'board',
    tone: 'rose',
    group: { 'zh-Hans': '系统', en: 'System' },
    tags: ['board.model', 'cpu.governor', 'gpu.freq_hz'],
  },
  'build-deploy': {
    name: { 'zh-Hans': '编译上板', en: 'Build and deploy' },
    note: { 'zh-Hans': '流程 · 编译 / 上传 / 运行', en: 'Workflow · compile / upload / run' },
    icon: 'activity',
    tone: 'blue',
    group: { 'zh-Hans': '系统', en: 'System' },
    tags: [],
  },
  workflows: {
    name: { 'zh-Hans': '流程', en: 'Workflows' },
    note: { 'zh-Hans': '体检 · 自检 · 抓帧 · 测速', en: 'Health check · self test · capture · benchmark' },
    icon: 'activity',
    tone: 'cyan',
    group: { 'zh-Hans': '系统', en: 'System' },
    tags: [],
  },
  'board-hardware': {
    name: { 'zh-Hans': '板卡硬件', en: 'Board hardware' },
    note: { 'zh-Hans': '手册清单 · 参考', en: 'Manual inventory · reference' },
    icon: 'board',
    tone: 'slate',
    group: { 'zh-Hans': '系统', en: 'System' },
    tags: ['board.model'],
  },
  'board-actions': {
    name: { 'zh-Hans': '板级操作', en: 'Board actions' },
    note: { 'zh-Hans': 'LED · 背光 · 调频', en: 'LED · backlight · governor' },
    icon: 'bolt',
    tone: 'amber',
    group: { 'zh-Hans': '系统', en: 'System' },
    tags: ['cpu.governor', 'custom.rk3588-atk.backlight.brightness'],
  },
  'boot-log': {
    name: { 'zh-Hans': '启动日志', en: 'Boot log' },
    note: { 'zh-Hans': '内核启动信息', en: 'Kernel boot messages' },
    icon: 'activity',
    tone: 'cyan',
    group: { 'zh-Hans': '系统', en: 'System' },
    tags: [],
  },
};

const FALLBACK: CardLook = {
  name: { 'zh-Hans': '自定义卡片', en: 'Custom card' },
  note: { 'zh-Hans': '自定义', en: 'Custom' },
  icon: 'activity',
  tone: 'slate',
  group: { 'zh-Hans': '自定义', en: 'Custom' },
  tags: [],
};

/**
 * The display metadata for a card.
 *
 * An unknown card falls back to its raw id, so a card the AI just wrote
 * still looks intentional.
 *
 * The text is returned in both languages. The caller picks, because the
 * component knows the active locale.
 */
export function cardLook(cardId: string): CardLook {
  const look = LOOKS[cardId];
  if (look === undefined) {
    return { ...FALLBACK, name: { 'zh-Hans': cardId, en: cardId } };
  }
  return look;
}

/** CSS custom property value for the card's accent. */
export function cardToneVar(tone: CardTone): string {
  switch (tone) {
    case 'blue':
      return 'var(--cockpit-accent)';
    case 'violet':
      return 'var(--cockpit-accent-2)';
    case 'green':
      return 'var(--cockpit-ok)';
    case 'amber':
      return 'var(--cockpit-warn)';
    case 'cyan':
      return 'var(--cockpit-series-3)';
    case 'rose':
      return 'var(--cockpit-danger)';
    default:
      return 'var(--cockpit-text-dim)';
  }
}

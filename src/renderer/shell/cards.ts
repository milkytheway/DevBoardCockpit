/**
 * Display metadata for the cards the host knows about.
 *
 * The host never inspects a card's internals — the manifest only carries the
 * machine identity (`cpu-usage`). This module turns that id into the words
 * and the pictogram the shell draws in its chrome, the detail panel and the
 * card library. An unknown card falls back to its raw id, so a card the AI
 * just wrote still looks intentional.
 */
export type CardTone = 'blue' | 'violet' | 'green' | 'amber' | 'cyan' | 'rose' | 'slate';

export interface CardLook {
  /** Human name shown in the card chrome. */
  name: string;
  /** One line: what the card is for. */
  note: string;
  /** Icon family drawn by the shell. */
  icon: 'cpu' | 'gpu' | 'memory' | 'thermal' | 'board' | 'activity';
  /** Accent used for the icon tile and the card's left edge. */
  tone: CardTone;
}

const LOOKS: Record<string, CardLook> = {
  'cpu-usage': {
    name: 'CPU 占用',
    note: '总占用 · 8 核分布',
    icon: 'cpu',
    tone: 'blue',
  },
  'core-load': {
    name: '核心负载',
    note: 'A55 / A76 逐核负载',
    icon: 'activity',
    tone: 'cyan',
  },
  'gpu-npu': {
    name: 'GPU / NPU',
    note: '负载 · 频率 · 温度',
    icon: 'gpu',
    tone: 'violet',
  },
  memory: {
    name: '内存',
    note: '已用 / 可用 · 采样趋势',
    icon: 'memory',
    tone: 'green',
  },
  thermal: {
    name: '温度',
    note: 'SoC / GPU / NPU 温区',
    icon: 'thermal',
    tone: 'amber',
  },
  'board-identity': {
    name: '板卡身份',
    note: '型号 · 调频 · 背光',
    icon: 'board',
    tone: 'rose',
  },
};

const FALLBACK: CardLook = {
  name: '自定义卡片',
  note: 'AI 生成 · 沙箱运行',
  icon: 'activity',
  tone: 'slate',
};

export function cardLook(cardId: string): CardLook {
  return LOOKS[cardId] ?? { ...FALLBACK, name: cardId };
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

/**
 * The alias layer of the theme: the semantic names that the components and
 * the cards use.
 *
 * ── Why there is an alias layer ──
 *
 * Writing colour values (`#58A6FF`) straight into the code means that
 * changing the skin means changing hundreds of files; with aliases
 * (`var(--cockpit-accent)`), changing the skin only touches the seed.
 *
 * ── The ones with `contract: true` are the contract ──
 *
 * The contract (`docs/spec/03-card-manifest.md` section 6) requires that
 * cards must not hard-code colours and may only use the CSS variables the
 * host injects — but the contract does not say a single word about which
 * variables the host injects (verified: searching `spec/03` finds no
 * `CSS`, no word for a CSS variable and no `--cockpit`). Cards are written
 * by an AI and they need a list of what they may rely on.
 * → These 15 enter the contract (the UI design specification in the
 *   implementation-layer design notes, section 19.7).
 */
export interface AliasDef {
  /** The CSS variable name */
  name: string;
  /** Which role of the seed layer it corresponds to */
  role: string;
  /** Whether it enters the contract (cards may rely on it) */
  contract: boolean;
  /** Where it is used (for humans) */
  usage: string;
}

export const ALIASES: readonly AliasDef[] = [
  { name: '--cockpit-bg', role: 'bg-0', contract: true, usage: '应用底色' },
  { name: '--cockpit-bg-elevated', role: 'bg-2', contract: true, usage: '面板抬头 / 输入框 / 悬浮' },
  { name: '--cockpit-surface', role: 'bg-1', contract: false, usage: '面板与卡片底' },
  { name: '--cockpit-surface-active', role: 'bg-3', contract: false, usage: '选中面' },
  { name: '--cockpit-border', role: 'border', contract: true, usage: '发丝分隔线' },
  { name: '--cockpit-border-strong', role: 'border-strong', contract: false, usage: '面板边框 / 输入框（≥3:1）' },
  { name: '--cockpit-text', role: 'text-0', contract: true, usage: '正文 / 读数数字' },
  { name: '--cockpit-text-dim', role: 'text-1', contract: true, usage: '次要文字 / 单位 / 标签' },
  { name: '--cockpit-text-faint', role: 'text-2', contract: true, usage: '弱化文字 / 空状态' },
  { name: '--cockpit-accent', role: 'accent', contract: true, usage: '唯一强调色：选中 / 聚焦 / 链接' },
  { name: '--cockpit-accent-2', role: 'accent-2', contract: true, usage: '第二强调 / 图表第二序列' },
  { name: '--cockpit-ok', role: 'ok', contract: true, usage: '正常 / live' },
  { name: '--cockpit-warn', role: 'warn', contract: true, usage: '降级 / stale' },
  { name: '--cockpit-danger', role: 'danger', contract: true, usage: '错误 / destructive' },
  { name: '--cockpit-unavailable', role: 'unknown', contract: true, usage: '**不可用**：这块板不提供这个能力' },
  { name: '--cockpit-series-1', role: 'series-1', contract: false, usage: '图表序列 1' },
  { name: '--cockpit-series-2', role: 'series-2', contract: false, usage: '图表序列 2' },
  { name: '--cockpit-series-3', role: 'series-3', contract: false, usage: '图表序列 3' },
  { name: '--cockpit-series-4', role: 'series-4', contract: false, usage: '图表序列 4' },
  { name: '--cockpit-series-5', role: 'series-5', contract: false, usage: '图表序列 5' },
  { name: '--cockpit-series-6', role: 'series-6', contract: false, usage: '图表序列 6' },
  { name: '--cockpit-series-7', role: 'series-7', contract: false, usage: '图表序列 7' },
  // ── The last three of the contract: geometry and fonts ──
  { name: '--cockpit-radius', role: 'radius-control', contract: true, usage: '控件圆角' },
  { name: '--cockpit-font-mono', role: 'font-mono', contract: true, usage: '等宽（读数 / 终端 / tag 名）' },
  { name: '--cockpit-font-ui', role: 'font-ui', contract: true, usage: '界面字体' },
];

/** The 15 of the contract (the ones cards may rely on) */
export const CONTRACT_ALIASES: readonly AliasDef[] = ALIASES.filter((a) => a.contract);

/**
 * 主题的**别名层**：组件与卡片用的语义名。
 *
 * ── 为什么要「别名」这一层 ──
 *
 * 直接用色值（`#58A6FF`）写代码，换皮就得**改几百个文件**；
 * 用别名（`var(--cockpit-accent)`），换皮只改种子。
 *
 * ── `contract: true` 的那些是**契约** ──
 *
 * 契约 `spec/03` §六 要求「卡片不得硬编码颜色，只用宿主注入的 CSS 变量」——
 * 但**宿主注入哪些变量，契约里一个字都没有**（实测：`spec/03` 搜不到 `CSS` / `变量` / `--cockpit`）。
 * 卡片是 AI 写的，它需要一份「**可以依赖什么**」的清单。
 * → 这 15 个进契约（`docs/UI设计/01-UI设计总纲.md` §19·7）。
 */
export interface AliasDef {
  /** CSS 变量名 */
  name: string;
  /** 对应种子层的哪个角色 */
  role: string;
  /** 是否进契约（卡片**可以**依赖） */
  contract: boolean;
  /** 用在哪（给人看） */
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
  // ── 契约里的最后三个：几何与字体 ──
  { name: '--cockpit-radius', role: 'radius-control', contract: true, usage: '控件圆角' },
  { name: '--cockpit-font-mono', role: 'font-mono', contract: true, usage: '等宽（读数 / 终端 / tag 名）' },
  { name: '--cockpit-font-ui', role: 'font-ui', contract: true, usage: '界面字体' },
];

/** 契约里的那 15 个（卡片可以依赖的） */
export const CONTRACT_ALIASES: readonly AliasDef[] = ALIASES.filter((a) => a.contract);

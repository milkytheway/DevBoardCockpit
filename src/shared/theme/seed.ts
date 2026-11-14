/**
 * 主题的**种子层**：手挑的那几十个值。
 *
 * ── 这是整个视觉系统里**唯一**「人挑」的地方 ──
 *
 * 换皮 = 改这里 → 重新推导 → 全应用（连卡片一起）跟着变。
 * 别的层（映射、别名）**不许出现色值**。
 *
 * ── 色值都实测过 ──
 *
 * 暗色与浅色各自成一套，**不是把一套反过来**：
 * 语义色在白底上要压明度（`--warn` 在白底上 2.37:1 是**读不出来**的），
 * 在黑底上要提亮度。
 * 具体的对比度见 `docs/UI设计/01-UI设计总纲.md` §7.3，
 * 判据由 `tests/unit/theme/map.test.ts` 守着。
 */
export type ThemeName = 'dark' | 'light';

/** 暗色皮肤（v1 精做的那套） */
const DARK: Record<string, string> = {
  'bg-0': '#0A0C0F',
  'bg-1': '#12151A',
  'bg-2': '#161A20',
  'bg-3': '#1C2129',
  'text-0': '#E6EAF2',
  'text-1': '#9BA6B6',
  'text-2': '#8B95A5',
  'accent': '#58A6FF',
  'accent-2': '#A371F7',
  'ok': '#3FB950',
  'warn': '#D29922',
  'danger': '#F85149',
  'unknown': '#8B95A5',
  'border': '#262D37',
  'border-strong': '#65727F',
  'series-1': '#58A6FF',
  'series-2': '#3FB950',
  'series-3': '#D29922',
  'series-4': '#A371F7',
  'series-5': '#39C5BB',
  'series-6': '#F85149',
  'series-7': '#F09A5A',
};

/** 浅色皮肤（架构齐备，v1 不精做） */
const LIGHT: Record<string, string> = {
  'bg-0': '#F5F6F7',
  'bg-1': '#FFFFFF',
  'bg-2': '#FFFFFF',
  'bg-3': '#F1F4F6',
  'text-0': '#1F2329',
  'text-1': '#5C646E',
  'text-2': '#656E78',
  'accent': '#1F5AE0',
  'accent-2': '#6B3FA0',
  'ok': '#0A7A2E',
  'warn': '#A85A00',
  'danger': '#C93A3A',
  'unknown': '#656E78',
  'border': '#DEE0E3',
  'border-strong': '#8A9099',
  'series-1': '#1F5AE0',
  'series-2': '#0A7A2E',
  'series-3': '#A85A00',
  'series-4': '#6B3FA0',
  'series-5': '#006B70',
  'series-6': '#C93A3A',
  'series-7': '#A34612',
};

/** 两套皮肤的种子 */
export const SEEDS: Readonly<Record<ThemeName, Readonly<Record<string, string>>>> = {
  dark: DARK,
  light: LIGHT,
};

/**
 * 与皮肤**无关**的那部分：几何、字体、字号、间距。
 *
 * 它们不是「皮肤」，是**产品**——两套皮肤共用同一套。
 */
export const GEOMETRY: Readonly<Record<string, string>> = {
  'radius-control': '4px',
  'radius-card': '8px',
  'radius-panel': '6px',
  'radius-float': '12px',
  'font-ui': "'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, sans-serif",
  'font-mono': "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
  'font-label': "'Bahnschrift', 'DIN Alternate', 'Segoe UI Variable', sans-serif",
  'space-1': '4px',
  'space-2': '8px',
  'space-3': '12px',
  'space-4': '16px',
  'space-5': '20px',
  'space-6': '24px',
  'space-8': '32px',
  'type-caption': '11px',
  'type-small': '12px',
  'type-body': '13px',
  'type-lead': '15px',
  'type-title': '18px',
  'type-metric': '34px',
  'row-height': '22px',
  'activity-width': '48px',
  'statusbar-height': '22px',
};

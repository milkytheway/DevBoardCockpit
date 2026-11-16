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
  'bg-0': '#141414',
  'bg-1': '#1F1F1F',
  'bg-2': '#262626',
  'bg-3': '#303030',
  'text-0': '#F0F0F0',
  'text-1': '#BFBFBF',
  'text-2': '#A6A6A6',
  'accent': '#4096FF',
  'accent-2': '#B37FEB',
  'ok': '#49AA19',
  'warn': '#D89614',
  'danger': '#FF7875',
  'unknown': '#8C8C8C',
  'border': '#424242',
  'border-strong': '#7A7A7A',
  'series-1': '#4096FF',
  'series-2': '#49AA19',
  'series-3': '#D89614',
  'series-4': '#B37FEB',
  'series-5': '#13C2C2',
  'series-6': '#FF7875',
  'series-7': '#FA8C16',
}

/** 浅色皮肤（架构齐备，v1 不精做） */
const LIGHT: Record<string, string> = {
  'bg-0': '#F5F5F5',
  'bg-1': '#FFFFFF',
  'bg-2': '#FAFAFA',
  'bg-3': '#F0F0F0',
  'text-0': '#1F1F1F',
  'text-1': '#595959',
  'text-2': '#666666',
  'accent': '#0958D9',
  'accent-2': '#531DAB',
  'ok': '#237804',
  'warn': '#874D00',
  'danger': '#CF1322',
  'unknown': '#666666',
  'border': '#D9D9D9',
  'border-strong': '#8C8C8C',
  'series-1': '#0958D9',
  'series-2': '#237804',
  'series-3': '#874D00',
  'series-4': '#531DAB',
  'series-5': '#08979C',
  'series-6': '#CF1322',
  'series-7': '#D46B08',
}

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

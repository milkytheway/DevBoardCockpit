import { aliasVars } from './map';
import { SEEDS, type ThemeName } from './seed';

/**
 * ECharts 的主题（**由 token 派生**）。
 *
 * ── 为什么宿主给 ──
 *
 * 契约 ADR-D27：ECharts **由宿主提供给卡片**（卡片的网络被 CSP 断了，
 * 它自己下载不了）。那**主题**也该由宿主给——
 * 否则每张卡各自配色，**「统一皮肤」这件事当场就破**。
 *
 * → 宿主生成一份主题 JSON，卡片 `import` 它，
 * 卡片里的图表**自动**跟着宿主皮肤走 ✓。
 */
export function echartsTheme(theme: ThemeName): Record<string, unknown> {
  const vars = aliasVars(theme);
  const series = [1, 2, 3, 4, 5, 6, 7].map(
    (i) => vars[`--cockpit-series-${i}`] ?? vars['--cockpit-accent'],
  );
  // 回落值取自**种子**——这里不再手写色值（第二份真相的温床）。
  const seed = SEEDS[theme];
  const text = vars['--cockpit-text'] ?? seed['text-0'];
  const dim = vars['--cockpit-text-dim'] ?? seed['text-1'];
  const faint = vars['--cockpit-text-faint'] ?? seed['text-2'];
  const border = vars['--cockpit-border'] ?? seed['border'];
  const surface = vars['--cockpit-surface'] ?? seed['bg-1'];

  return {
    color: series,
    backgroundColor: 'transparent',
    textStyle: {
      fontFamily: vars['--cockpit-font-ui'],
      color: text,
    },
    title: { textStyle: { color: text, fontSize: 13, fontWeight: 600 } },
    legend: { textStyle: { color: dim, fontSize: 11 } },
    line: {
      itemStyle: { borderWidth: 1.5 },
      lineStyle: { width: 1.5 },
      symbol: 'none',
      smooth: false,
    },
    categoryAxis: {
      axisLine: { lineStyle: { color: border } },
      axisTick: { show: false },
      axisLabel: { color: faint, fontSize: 11 },
      splitLine: { show: false },
    },
    valueAxis: {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: faint, fontSize: 11 },
      splitLine: { lineStyle: { color: border, width: 1 } },
    },
    tooltip: {
      backgroundColor: surface,
      borderColor: border,
      textStyle: { color: text, fontSize: 12 },
    },
  };
}

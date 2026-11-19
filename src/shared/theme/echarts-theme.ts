import { aliasVars } from './map';
import { SEEDS, type ThemeName } from './seed';

/**
 * The theme of ECharts (derived from the tokens).
 *
 * ── Why the host provides it ──
 *
 * Contract ADR-D27: ECharts is provided by the host to the cards (the
 * network of a card is cut off by the CSP, so it cannot download it
 * itself). The theme has to come from the host as well — otherwise every
 * card picks its own colours and the idea of one unified skin falls apart
 * on the spot.
 *
 * → The host generates one theme JSON, the card `import`s it, and the
 *   charts inside the card automatically follow the skin of the host.
 */
export function echartsTheme(theme: ThemeName): Record<string, unknown> {
  const vars = aliasVars(theme);
  const series = [1, 2, 3, 4, 5, 6, 7].map(
    (i) => vars[`--cockpit-series-${i}`] ?? vars['--cockpit-accent'],
  );
  // The fallback values come from the seed — no colour value is written by
  // hand here (the breeding ground of a second source of truth).
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

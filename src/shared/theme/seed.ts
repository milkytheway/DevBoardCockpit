/**
 * The seed layer of the theme: the few dozen values that were picked by
 * hand.
 *
 * ── This is the only place in the whole visual system where a human picks ──
 *
 * Changing the skin = changing here → re-deriving → the whole application
 * (cards included) follows. No other layer (the mapping, the aliases) may
 * contain a colour value.
 *
 * ── The colour values are measured ──
 *
 * Dark and light are two sets of their own, not one set turned inside out:
 * a semantic colour has to have its lightness pushed down on a white
 * background (`--warn` at 2.37:1 on white cannot be read) and its
 * brightness pulled up on a black one. The exact contrast ratios are
 * tabulated in the UI design specification in the implementation-layer
 * design notes (section 7.3), and the criteria are guarded by
 * `tests/unit/theme/map.test.ts`.
 */
export type ThemeName = 'dark' | 'light';

/** The dark skin (the set that was carefully crafted in v1) */
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

/** The light skin (the architecture is complete, but v1 did not craft it carefully) */
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

/** The seeds of the two skins */
export const SEEDS: Readonly<Record<ThemeName, Readonly<Record<string, string>>>> = {
  dark: DARK,
  light: LIGHT,
};

/**
 * The part that is independent of the skin: geometry, fonts, type sizes and
 * spacing.
 *
 * They are not the "skin", they are the product — both skins share the same
 * ones.
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

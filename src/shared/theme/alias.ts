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
  { name: '--cockpit-bg', role: 'bg-0', contract: true, usage: 'the background of the application' },
  { name: '--cockpit-bg-elevated', role: 'bg-2', contract: true, usage: 'panel headers / inputs / hover' },
  { name: '--cockpit-surface', role: 'bg-1', contract: false, usage: 'the background of panels and cards' },
  { name: '--cockpit-surface-active', role: 'bg-3', contract: false, usage: 'the selected surface' },
  { name: '--cockpit-border', role: 'border', contract: true, usage: 'the hairline separator' },
  { name: '--cockpit-border-strong', role: 'border-strong', contract: false, usage: 'panel borders / inputs (>=3:1)' },
  { name: '--cockpit-text', role: 'text-0', contract: true, usage: 'body text / the numbers of a reading' },
  { name: '--cockpit-text-dim', role: 'text-1', contract: true, usage: 'secondary text / units / labels' },
  { name: '--cockpit-text-faint', role: 'text-2', contract: true, usage: 'faint text / the empty state' },
  { name: '--cockpit-accent', role: 'accent', contract: true, usage: 'the one accent: selected / focused / a link' },
  { name: '--cockpit-accent-2', role: 'accent-2', contract: true, usage: 'the second accent / the second series of a chart' },
  { name: '--cockpit-ok', role: 'ok', contract: true, usage: 'normal / live' },
  { name: '--cockpit-warn', role: 'warn', contract: true, usage: 'degraded / stale' },
  { name: '--cockpit-danger', role: 'danger', contract: true, usage: 'error / destructive' },
  { name: '--cockpit-unavailable', role: 'unknown', contract: true, usage: '**unavailable**: the board does not offer this capability' },
  { name: '--cockpit-series-1', role: 'series-1', contract: false, usage: 'chart series 1' },
  { name: '--cockpit-series-2', role: 'series-2', contract: false, usage: 'chart series 2' },
  { name: '--cockpit-series-3', role: 'series-3', contract: false, usage: 'chart series 3' },
  { name: '--cockpit-series-4', role: 'series-4', contract: false, usage: 'chart series 4' },
  { name: '--cockpit-series-5', role: 'series-5', contract: false, usage: 'chart series 5' },
  { name: '--cockpit-series-6', role: 'series-6', contract: false, usage: 'chart series 6' },
  { name: '--cockpit-series-7', role: 'series-7', contract: false, usage: 'chart series 7' },
  // ── The last three of the contract: geometry and fonts ──
  { name: '--cockpit-radius', role: 'radius-control', contract: true, usage: 'the corner radius of the controls' },
  { name: '--cockpit-font-mono', role: 'font-mono', contract: true, usage: 'monospace (a reading / the terminal / a tag name)' },
  { name: '--cockpit-font-ui', role: 'font-ui', contract: true, usage: 'the font of the interface' },
];

/** The 15 of the contract (the ones cards may rely on) */
export const CONTRACT_ALIASES: readonly AliasDef[] = ALIASES.filter((a) => a.contract);

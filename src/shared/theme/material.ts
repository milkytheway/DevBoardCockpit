/**
 * The material layer of the theme: the veils, the edge highlights, the
 * shadows and the canvas base.
 *
 * ── Why this layer exists ──
 *
 * The contract layer (`seed.ts` → `map.ts` → `alias.ts`) is about
 * semantics: "this colour means normal / means danger / means body text".
 *
 * But the shell needs another kind of colour, one that stands for no
 * semantics at all and only says "material": the reflection of a sheet of
 * glass, a 1px highlight along the top edge, the density of a shadow.
 * These colours used to be written straight into the CSS — `visual.css`
 * once carried 43 hard-coded values, so "changing the base colour meant
 * changing 43 places" and "nobody could tell which values were
 * deliberate and which were written by hand".
 *
 * → This layer registers them as tiers. Once they are registered:
 *   1. every colour value has a name, a description of its purpose and a
 *      family it belongs to;
 *   2. no colour literal appears in the CSS any more (guarded by
 *      `tests/web/visual-material.test.ts`);
 *   3. changing the skin means changing one place, and the whole
 *      application follows.
 *
 * ── Why the name is `--shell-mat-*` and not `--cockpit-*` ──
 *
 * `--cockpit-*` is the contract prefix: the dozen-odd names a card may
 * rely on. The material layer belongs to the shell alone — cards cannot
 * reach it and must not reach it: as soon as cards could use
 * `--cockpit-mat-*` as well, they would start building a second set of
 * materials of their own and the idea of one unified skin would fall apart
 * on the spot.
 * → The `--shell-mat-*` prefix puts the boundary into the name itself.
 *
 * ── One hard rule ──
 *
 * Not one of the values in here may be copied into the CSS a second
 * time. To use one, write `var(--shell-mat-*)`.
 *
 * ── The difference from `seed.ts` ──
 *
 * `seed.ts` is picked by hand (changing the skin means changing there).
 * This layer is registered (the shell uses it itself; it does not make the
 * work of the person changing the skin harder, but it is not written by
 * hand either). Both of them hold values only, never the way to use them.
 */

import type { ThemeName } from './seed';

/** The material family — it answers "what kind of colour is this" */
export type MaterialFamily =
  /** Veil: the translucent base laid UNDER the content */
  | 'veil'
  /** Edge: outlines, highlights along the top edge, hairlines */
  | 'edge'
  /** Sheen: the gradient layer on the face of a panel/card */
  | 'sheen'
  /** Lift: the shadows of something raised, pressed down or dragged */
  | 'lift'
  /** Canvas: the layer at the very bottom */
  | 'canvas';

/**
 * The state of a tier:
 * - `active` — the version in effect right now
 * - `legacy` — overridden by a later rule, but kept on purpose (removing it
 *   would risk a change in the looks, which outweighs the gain, and these
 *   are the evidence of the historical design: v0.6 → v0.7 iterated on the
 *   glass look three times)
 */
export type MaterialStatus = 'active' | 'legacy';

export interface MaterialDef {
  /** The CSS variable name (`--shell-mat-*`) */
  name: string;
  /** The value under the dark skin */
  dark: string;
  /** The value under the light skin (most of them are the same as under the dark one — a material is a "thickness", not a "colour") */
  light: string;
  /** The family */
  family: MaterialFamily;
  /** In effect right now / kept as history */
  status: MaterialStatus;
  /** What this material is for (for humans) */
  usage: string;
}

/**
 * The table of the material tiers.
 *
 * ⚠️ The values here are identical, character by character, with the
 * original ones in `visual.css` — this layer registers, it does not change
 * the design. The looks must not change by a single byte.
 */
export const MATERIALS: readonly MaterialDef[] = [
  // ── veil: the translucent base laid under the content ─────────
  {
    name: '--shell-mat-veil-code',
    dark: 'rgba(4, 6, 9, 0.5)',
    light: 'rgba(4, 6, 9, 0.5)',
    family: 'veil',
    status: 'legacy',
    usage: 'the background of the raw reading (JSON) block - the v0.6 rule, later covered by the color-mix version',
  },
  {
    name: '--shell-mat-veil-terminal',
    dark: 'rgba(6, 8, 11, 0.66)',
    light: 'rgba(6, 8, 11, 0.66)',
    family: 'veil',
    status: 'active',
    usage: 'the background of the terminal pane - the terminal has to sink into the page, it may not be as bright as a panel',
  },
  {
    name: '--shell-mat-veil-canvas',
    dark: 'radial-gradient(80% 60% at 40% 40%, rgba(255, 255, 255, 0.025), transparent 70%)',
    light: 'radial-gradient(80% 60% at 40% 40%, rgba(255, 255, 255, 0.025), transparent 70%)',
    family: 'veil',
    status: 'legacy',
    usage: 'the ring of ambient light in the middle of the canvas - the v0.6 glass pass',
  },

  // ── edge: outlines and highlights ─────────────────────────────
  {
    name: '--shell-mat-edge-highlight',
    dark: 'rgba(255, 255, 255, 0.06)',
    light: 'rgba(255, 255, 255, 1)',
    family: 'edge',
    status: 'active',
    usage: 'the 1px highlight along the top edge - panels / cards / panes share it; it is the main signal that "this is floating"',
  },
  {
    name: '--shell-mat-edge-bright',
    dark: 'rgba(255, 255, 255, 0.35)',
    light: 'rgba(255, 255, 255, 0.35)',
    family: 'edge',
    status: 'active',
    usage: 'the strong highlight along the top edge of the primary button - the primary button is the only thing allowed to "glow"',
  },
  {
    name: '--shell-mat-edge-hairline',
    dark: 'rgba(255, 255, 255, 0.16)',
    light: 'rgba(255, 255, 255, 0.16)',
    family: 'edge',
    status: 'active',
    usage: 'the little white mixed into the hairline - a pure border is too hard; the white gives it the feel of a "metal thread"',
  },


  // ── sheen: the gradient highlight on a face ───────────────────
  {
    name: '--shell-mat-sheen-card',
    dark: 'linear-gradient(180deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.025) 46%)',
    light: 'linear-gradient(180deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.025) 46%)',
    family: 'sheen',
    status: 'active',
    usage: 'the gradient highlight on the face of a glass card - the value in effect since v0.7',
  },
  {
    name: '--shell-mat-sheen-card-v2',
    dark: 'linear-gradient(180deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.02) 48%)',
    light: 'linear-gradient(180deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.02) 48%)',
    family: 'sheen',
    status: 'legacy',
    usage: 'the highlight on the face of a glass card - the first pass of v0.7, covered by the later one',
  },
  {
    name: '--shell-mat-sheen-card-v1',
    dark: 'linear-gradient(180deg, rgba(255, 255, 255, 0.075), rgba(255, 255, 255, 0.012) 46%)',
    light: 'linear-gradient(180deg, rgba(255, 255, 255, 0.075), rgba(255, 255, 255, 0.012) 46%)',
    family: 'sheen',
    status: 'legacy',
    usage: 'the highlight on the face of a glass card - v0.6',
  },
  {
    name: '--shell-mat-pure-white',
    dark: '#ffffff',
    light: '#ffffff',
    family: 'sheen',
    status: 'active',
    usage: 'the pure white on the light skin - the background of an overlay, the start of a gradient',
  },

  // ── canvas: the layer at the very bottom ─────────────────────
  {
    name: '--shell-mat-canvas',
    dark: '#06080b',
    light: '#F5F6F7',
    family: 'canvas',
    status: 'active',
    usage: 'the background of the glass canvas - in the dark skin it is blacker than --cockpit-bg so that the overlays float; in the light skin a warm grey carries them',
  },
  {
    name: '--shell-mat-canvas-v1',
    dark: '#07090c',
    light: '#EEF0F2',
    family: 'canvas',
    status: 'legacy',
    usage: 'the background of the glass canvas - the first pass of v0.7',
  },

  // ── lift: shadows ────────────────────────────────────────────
  {
    name: '--shell-mat-shadow-card',
    dark: '0 18px 36px -26px rgba(0, 0, 0, 0.9), 0 2px 6px -3px rgba(0, 0, 0, 0.4)',
    light: '0 10px 26px -20px rgba(23, 30, 40, 0.28), 0 1px 2px -1px rgba(23, 30, 40, 0.14)',
    family: 'lift',
    status: 'active',
    usage: 'the ordinary shadow of panels and panes - the light skin uses a cool grey with a hue, not pure black',
  },
  {
    name: '--shell-mat-shadow-float',
    dark: '0 24px 60px -30px rgba(0, 0, 0, 0.95)',
    light: '0 24px 60px -30px rgba(23, 30, 40, 0.3)',
    family: 'lift',
    status: 'active',
    usage: 'the shadow of an overlay (the palette / the card menu) - further away and lighter than the ordinary shadow',
  },
  {
    name: '--shell-mat-shadow-glass',
    dark:
      '0 34px 66px -32px rgba(0, 0, 0, 0.98), 0 10px 26px -14px rgba(0, 0, 0, 0.62), inset 0 1px 0 rgba(255, 255, 255, 0.12)',
    light:
      '0 34px 66px -32px rgba(0, 0, 0, 0.98), 0 10px 26px -14px rgba(0, 0, 0, 0.62), inset 0 1px 0 rgba(255, 255, 255, 0.12)',
    family: 'lift',
    status: 'active',
    usage: 'the shadow of a glass card - the value in effect since v0.7 (a far shadow + a near shadow + an inset highlight along the top edge)',
  },
  {
    name: '--shell-mat-shadow-glass-hover',
    dark:
      '0 44px 86px -34px rgba(0, 0, 0, 1), 0 14px 34px -16px rgba(0, 0, 0, 0.7), inset 0 1px 0 rgba(255, 255, 255, 0.16)',
    light:
      '0 44px 86px -34px rgba(0, 0, 0, 1), 0 14px 34px -16px rgba(0, 0, 0, 0.7), inset 0 1px 0 rgba(255, 255, 255, 0.16)',
    family: 'lift',
    status: 'active',
    usage: 'the shadow of a glass card under the pointer - bigger and darker than the resting one',
  },
  {
    name: '--shell-mat-shadow-glass-v1',
    dark:
      '0 28px 56px -30px rgba(0, 0, 0, 0.95), 0 6px 18px -10px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.09)',
    light:
      '0 28px 56px -30px rgba(0, 0, 0, 0.95), 0 6px 18px -10px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.09)',
    family: 'lift',
    status: 'legacy',
    usage: 'the shadow of a glass card - the v0.6 glass pass',
  },
  {
    name: '--shell-mat-shadow-glass-hover-v1',
    dark:
      '0 34px 64px -30px rgba(0, 0, 0, 0.98), 0 10px 24px -12px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.12)',
    light:
      '0 34px 64px -30px rgba(0, 0, 0, 0.98), 0 10px 24px -12px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.12)',
    family: 'lift',
    status: 'legacy',
    usage: 'the shadow of a glass card under the pointer - the v0.6 glass pass',
  },
  {
    name: '--shell-mat-shadow-detail',
    dark: '-24px 0 48px rgba(0, 0, 0, 0.42)',
    light: '-24px 0 48px rgba(30, 40, 55, 0.16)',
    family: 'lift',
    status: 'active',
    usage: 'the shadow of the detail column - only on the left (it is an overlay, it has no edge on the right)',
  },
  {
    name: '--shell-mat-shadow-detail-v1',
    dark: '-20px 0 40px -32px rgba(0, 0, 0, 0.9)',
    light: '-20px 0 40px -32px rgba(0, 0, 0, 0.9)',
    family: 'lift',
    status: 'legacy',
    usage: 'the early shadow of the detail column - covered by the later .detail rule',
  },
  {
    name: '--shell-mat-shadow-active',
    dark: '0 6px 16px -12px rgba(0, 0, 0, 0.8)',
    light: '0 6px 16px -12px rgba(0, 0, 0, 0.8)',
    family: 'lift',
    status: 'active',
    usage: 'the shadow of the selected row in the sidebar - the selected row is "lifted", not "recoloured"',
  },
  {
    name: '--shell-mat-shadow-lift',
    dark: '0 30px 60px -26px rgba(0, 0, 0, 0.9)',
    light: '0 30px 60px -26px rgba(0, 0, 0, 0.9)',
    family: 'lift',
    status: 'active',
    usage: 'the shadow of a card that is lifted while it is dragged',
  },
  {
    name: '--shell-mat-shadow-hover-v1',
    dark: '0 22px 44px -24px rgba(0, 0, 0, 0.95)',
    light: '0 22px 44px -24px rgba(0, 0, 0, 0.95)',
    family: 'lift',
    status: 'legacy',
    usage: 'the shadow of a card under the pointer - v0.6, covered by the glass version',
  },
  {
    name: '--shell-mat-shadow-selected',
    dark: '0 24px 48px -26px rgba(0, 0, 0, 0.95)',
    light: '0 24px 48px -26px rgba(0, 0, 0, 0.95)',
    family: 'lift',
    status: 'active',
    usage: 'the shadow of the selected card - being selected is "picked up to look at", not "lit up"',
  },
];

/** Material variable name → the value under that skin */
export function materialVars(theme: ThemeName): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of MATERIALS) {
    out[m.name] = theme === 'light' ? m.light : m.dark;
  }
  return out;
}

/** Every name of the material layer */
export const MATERIAL_NAMES: readonly string[] = MATERIALS.map((m) => m.name);
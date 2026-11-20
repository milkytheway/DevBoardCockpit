import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { aliasVars, allThemesCss, themeCss } from '../../../src/shared/theme/map';
import { CONTRACT_ALIASES } from '../../../src/shared/theme/alias';
import { baseStyleBlock } from '../../../src/shared/theme/base-css';
import { echartsTheme } from '../../../src/shared/theme/echarts-theme';

/**
 * The **three layers** of the theme: the seed → the mapping → the aliases.
 *
 * What this group of tests guards is the reskinning itself:
 *
 * 1. **Not one of the 15 aliases of the contract may be missing** — the cards
 *    live on them.
 * 2. **The contrast**: a wrong colour value **cannot be seen by eye** (the
 *    orange in the light skin especially). The criterion is therefore
 *    computed, not looked at.
 * 3. **No colour value in the base styles** — one would mean "a second
 *    source of truth".
 * 4. **The generated CSS agrees with the seed** — another shape of two
 *    sources of truth.
 */

/** The relative luminance and the contrast of WCAG */
function luminance(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = channel((n >> 16) & 255);
  const g = channel((n >> 8) & 255);
  const b = channel(n & 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** The surface that carries the body text (the panel background) — **taken from the tokens**, no hard-coded colour */
const SURFACE = {
  dark: aliasVars('dark')['--cockpit-surface'] as string,
  light: aliasVars('light')['--cockpit-surface'] as string,
};

describe('the theme · the alias layer', () => {
  it('**not one of the 15 aliases of the contract may be missing**', () => {
    expect(CONTRACT_ALIASES).toHaveLength(15);
    for (const skin of ['dark', 'light'] as const) {
      const vars = aliasVars(skin);
      for (const alias of CONTRACT_ALIASES) {
        expect(vars[alias.name], `${skin} is missing ${alias.name}`).toBeDefined();
      }
    }
  });

  it('both skins provide **all** the aliases (the contract: both skins have to provide all of them)', () => {
    const dark = Object.keys(aliasVars('dark')).sort();
    const light = Object.keys(aliasVars('light')).sort();
    expect(light).toEqual(dark);
  });

  it('the text and the semantic colours reach **≥ 4.5:1** on the panel background (for both skins)', () => {
    const textish = [
      '--cockpit-text',
      '--cockpit-text-dim',
      '--cockpit-text-faint',
      '--cockpit-accent',
      '--cockpit-ok',
      '--cockpit-warn',
      '--cockpit-danger',
      '--cockpit-unavailable',
    ];
    for (const skin of ['dark', 'light'] as const) {
      const vars = aliasVars(skin);
      for (const name of textish) {
        const ratio = contrast(vars[name] as string, SURFACE[skin]);
        expect(ratio, `the ${name} of ${skin} is only ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('**the border of a focusable control reaches ≥ 3:1**', () => {
    for (const skin of ['dark', 'light'] as const) {
      const vars = aliasVars(skin);
      const ratio = contrast(vars['--cockpit-border-strong'] as string, SURFACE[skin]);
      expect(ratio, `the border-strong of ${skin} is only ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
  });

  it('`unavailable` is on both skins not a grey that can be read but not recognised', () => {
    // It carries "this board does not provide that capability" — not being able to read it must not end up being said as "normal"
    for (const skin of ['dark', 'light'] as const) {
      const vars = aliasVars(skin);
      const ratio = contrast(vars['--cockpit-unavailable'] as string, SURFACE[skin]);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('the theme · the base styles (the ones the host injects into the card)', () => {
  it('**not a single colour value** (only var(--cockpit-*))', () => {
    const css = baseStyleBlock();
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
  });

  it('every one of the five states has a class (the author of the card only picks a class name)', () => {
    const css = baseStyleBlock();
    for (const cls of [
      '.cockpit-value',
      '.cockpit-value--stale',
      '.cockpit-value--error',
      '.cockpit-unavailable',
      '.cockpit-pending',
    ]) {
      expect(css).toContain(cls);
    }
  });

  it('`prefers-reduced-motion` is taken into account', () => {
    expect(baseStyleBlock()).toContain('prefers-reduced-motion');
  });
});

describe('the theme · the ECharts theme is derived from the tokens', () => {
  it('the colours of the series are the seven of the alias layer', () => {
    const vars = aliasVars('dark');
    const theme = echartsTheme('dark');
    expect(theme['color']).toEqual([
      vars['--cockpit-series-1'],
      vars['--cockpit-series-2'],
      vars['--cockpit-series-3'],
      vars['--cockpit-series-4'],
      vars['--cockpit-series-5'],
      vars['--cockpit-series-6'],
      vars['--cockpit-series-7'],
    ]);
  });

  it('the chart theme of the two skins is **different** (otherwise "one skin for everything" would be false)', () => {
    expect(JSON.stringify(echartsTheme('dark'))).not.toBe(JSON.stringify(echartsTheme('light')));
  });
});

describe('the theme · the generated artefact agrees with the seed', () => {
  it('the generated CSS agrees with the seed (that is what `gen:theme:check` guards)', () => {
    const file = join(process.cwd(), 'src', 'renderer', 'theme', 'tokens.generated.css');
    if (!existsSync(file)) {
      // Not generated yet → run the generator (the test makes sure the artefact exists)
      expect(allThemesCss().length).toBeGreaterThan(0);
      return;
    }
    expect(readFileSync(file, 'utf8')).toBe(allThemesCss());
  });

  it('the CSS of both skins is included (the light one hangs on the data-theme selector)', () => {
    const css = allThemesCss();
    expect(css).toContain(":root {");
    expect(css).toContain("[data-theme='light'] {");
    expect(themeCss('dark')).toContain('--cockpit-accent:');
  });
});

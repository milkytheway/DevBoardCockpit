import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MATERIALS, materialVars } from '../../src/shared/theme/material';
import { themeCss, aliasVars } from '../../src/shared/theme/map';

/**
 * The mechanical judgments of the material layer and of colour discipline.
 *
 * ── Why this group of tests exists ──
 *
 * "Do not use colours carelessly" is not something a person can remember.
 * `visual.css` once held 43 hard-coded colour values, and adding one,
 * deleting one or changing one went unnoticed — because there was no
 * judgment. This group of tests is that judgment.
 *
 * ── The rules (all of them mechanically decidable) ──
 *
 * 1. **No colour literal in CSS that is not a generated artefact**
 *    (hex / rgb() / rgba() / hsl() / colour keywords).
 *    A colour has three legitimate sources: `--cockpit-*` (semantic),
 *    `--shell-mat-*` (material), and the white/black that `color-mix()`
 *    uses to shift lightness.
 * 2. **A colour keyword may only appear inside `color-mix()`**
 *    — a bare `color: white` is where careless colouring begins.
 * 3. **Every `--shell-mat-*` used in CSS must be registered in the material
 *    layer** (no shadow variables).
 * 4. **The material layer must have no orphans** (registered but never used
 *    means a second source of truth).
 * 5. **A card cannot reach the material layer** (`--shell-mat-*` belongs to
 *    the shell).
 * 6. **The producers of the theme must not hand-write colour values** (the
 *    terminal, ECharts, the base stylesheet of the cards).
 */

const ROOT = process.cwd();

/** Generated artefacts: the colour values belong here (they are derived from the seed) */
const GENERATED = ['src/renderer/theme/tokens.generated.css'];

/** The hand-written CSS that takes part in the check */
const HAND_WRITTEN = [
  'src/renderer/shell/shell.css',
  'src/renderer/shell/visual.css',
  'src/renderer/theme/app.css',
];

const CARD_CSS: string[] = [];
for (const name of readdirSync(join(ROOT, 'cards'))) {
  const p = join(ROOT, 'cards', name, 'style.css');
  try {
    if (statSync(p).isFile()) CARD_CSS.push(p);
  } catch {
    // A card directory without a style.css is skipped
  }
}

/** Remove the comments */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Remove the `color-mix(...)` calls (the parentheses are matched, nesting is allowed) */
function stripColorMix(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const idx = css.indexOf('color-mix(', i);
    if (idx === -1) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, idx);
    let depth = 0;
    let j = idx + 'color-mix'.length;
    for (; j < css.length; j++) {
      if (css[j] === '(') depth++;
      else if (css[j] === ')') {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    i = j;
  }
  return out;
}

/** Every colour literal in a stylesheet, with its position and text */
function colorLiterals(css: string): string[] {
  const stripped = stripComments(css);
  const outsideMix = stripColorMix(stripped);
  const hits: string[] = [];

  // hex：#rgb / #rgba / #rrggbb / #rrggbbaa
  for (const m of outsideMix.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    // Exclude the id selectors (`#root` and the like): a hex value must be exactly 3, 4, 6 or 8 digits
    const digits = m[0].slice(1);
    if (![3, 4, 6, 8].includes(digits.length)) continue;
    hits.push(m[0]);
  }
  // rgb / rgba / hsl / hsla / hwb
  for (const m of outsideMix.matchAll(/\b(?:rgba?|hsla?|hwb)\(/g)) hits.push(m[0]);

  // Colour keywords: a colour applied directly (white-space / tone-cyan / near-black do not count)
  const KEYWORDS =
    /\b(white|black|red|green|blue|gray|grey|orange|yellow|purple|pink|cyan|magenta|silver|gold|navy|teal|lime|maroon|olive|aqua|fuchsia|indigo|violet|crimson|salmon|tomato|beige|ivory|khaki|salmon)\b(?![-\w])/gi;
  for (const m of outsideMix.matchAll(KEYWORDS)) {
    const before = outsideMix[m.index - 1] ?? '';
    if (before === '-' || /[\w-]/.test(before)) continue;
    hits.push(m[0]);
  }
  return hits;
}

describe('Material layer · registration and reference close the loop', () => {
  it('every material has a name, a family, a status and a purpose (none of them is "added on the fly")', () => {
    for (const m of MATERIALS) {
      expect(m.name, 'a material name must start with --shell-mat-').toMatch(/^--shell-mat-[a-z0-9-]+$/);
      expect(['veil', 'edge', 'sheen', 'lift', 'canvas']).toContain(m.family);
      expect(['active', 'legacy']).toContain(m.status);
      expect(m.usage.length, `${m.name} has no purpose description`).toBeGreaterThan(4);
      expect(m.dark.length).toBeGreaterThan(0);
      expect(m.light.length).toBeGreaterThan(0);
    }
  });

  it('material names are unique', () => {
    const names = MATERIALS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('both skins get the same set of materials (one missing means the light skin was left out)', () => {
    const dark = Object.keys(materialVars('dark')).sort();
    const light = Object.keys(materialVars('light')).sort();
    expect(light).toEqual(dark);
  });

  it('the material layer does not reach the cards (a card may only use the contract aliases)', () => {
    const cardCss = themeCss('dark', ':root');
    expect(cardCss).not.toContain('--shell-mat-');
    // The application shell does get them
    expect(themeCss('dark', ':root', true)).toContain('--shell-mat-');
  });

  it('the card theme.css carries no shadow material variables either', () => {
    for (const name of MATERIALS.map((m) => m.name)) {
      expect(themeCss('dark', ':root')).not.toContain(name);
    }
  });

  it('the theme.css the card is actually given does not carry the material layer', () => {
    // The wiring is the place where a `true` slips in easily — so it is guarded.
    const src = readFileSync(join(ROOT, 'src/main/cards/wiring.ts'), 'utf8');
    expect(src).toContain("themeCss(theme(), ':root')");
    expect(src, 'the theme.css given to a card must not carry the material layer').not.toContain("themeCss(theme(), ':root', true)");
  });

  it('the variables pushed to a card are the alias layer, not the full set (which includes the material layer)', () => {
    const src = readFileSync(join(ROOT, 'src/main/cards/wiring.ts'), 'utf8');
    expect(src).toContain('return aliasVars(theme);');
    expect(src, 'the variables pushed to a card must not come from materialVars').not.toContain('materialVars');
  });

  it('every material is in the generated CSS (one missing means the shell lost a material)', () => {
    const css = readFileSync(join(ROOT, 'src/renderer/theme/tokens.generated.css'), 'utf8');
    for (const m of MATERIALS) {
      expect(css, `the generated CSS is missing ${m.name}`).toContain(`${m.name}:`);
    }
  });
});

describe('Material layer · no colour value is copied into CSS again', () => {
  it('the hand-written CSS holds no colour literal at all', () => {
    for (const rel of HAND_WRITTEN) {
      const css = readFileSync(join(ROOT, rel), 'utf8');
      const hits = colorLiterals(css);
      expect(hits, `${rel} still holds hard-coded colour values: ${hits.join(', ')}`).toEqual([]);
    }
  });

  it('the CSS of the cards holds no colour literal either', () => {
    for (const abs of CARD_CSS) {
      const css = readFileSync(abs, 'utf8');
      const hits = colorLiterals(css);
      expect(hits, `${abs.replace(ROOT, '')} still holds hard-coded colour values: ${hits.join(', ')}`).toEqual([]);
    }
  });

  it('a card may not use the material layer, which belongs to the shell', () => {
    for (const abs of CARD_CSS) {
      const css = readFileSync(abs, 'utf8');
      expect(css, `${abs.replace(ROOT, '')} uses --shell-mat-*`).not.toContain('--shell-mat-');
    }
  });

  it('only the files outside the generated artefacts are checked (the colour values of the artefacts come from the seed)', () => {
    for (const rel of GENERATED) {
      expect(HAND_WRITTEN).not.toContain(rel);
    }
  });
});

describe('Material layer · the reference loop (no shadow variables, no orphans)', () => {
  const shellCss = HAND_WRITTEN.map((rel) => readFileSync(join(ROOT, rel), 'utf8')).join('\n');

  it('every --shell-mat-* used in CSS is registered in the material layer', () => {
    const used = new Set([...shellCss.matchAll(/var\((--shell-mat-[a-z0-9-]+)/g)].map((m) => m[1]));
    const known = new Set(MATERIALS.map((m) => m.name));
    for (const name of used) {
      expect(known.has(name), `the CSS uses the unregistered material ${name}`).toBe(true);
    }
    expect(used.size, 'no material is used at all, so this layer is idle').toBeGreaterThan(0);
  });

  it('the material layer has no orphans (registered but unused means a second source of truth)', () => {
    for (const m of MATERIALS) {
      expect(shellCss, `${m.name} is registered but never used`).toContain(`var(${m.name})`);
    }
  });

  it('the material layer has one source: the CSS must not redefine --shell-mat-*', () => {
    for (const rel of HAND_WRITTEN) {
      const css = readFileSync(join(ROOT, rel), 'utf8');
      expect(css, `${rel} defines the material variables a second time`).not.toMatch(/--shell-mat-[a-z0-9-]+\s*:/);
    }
  });
});

describe('The producers of the theme must not hand-write colour values', () => {
  it('the terminal theme (shell/theme.ts) holds no colour literal', () => {
    const src = readFileSync(join(ROOT, 'src/renderer/shell/theme.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(code).not.toMatch(/\brgba?\(/);
  });

  it('the terminal component (TerminalView.tsx) holds no colour literal', () => {
    const src = readFileSync(join(ROOT, 'src/renderer/terminal/TerminalView.tsx'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code, 'the terminal component must not keep a fallback colour set of its own (that would be a second source of truth)').not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('the ECharts theme (echarts-theme.ts) holds no colour literal', () => {
    const src = readFileSync(join(ROOT, 'src/shared/theme/echarts-theme.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(code).not.toMatch(/['"][#a-f0-9]{6}['"]/i);
  });

  it('the base stylesheet the host injects into a card holds no colour literal', () => {
    const src = readFileSync(join(ROOT, 'src/shared/theme/base-css.ts'), 'utf8');
    const code = src.replace(/`[\s\S]*?`/g, '');
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('Terminal theme · one source', () => {
  it('the fallback colours of the terminal are the values of the seed (not a second copy)', async () => {
    const { xtermThemeFromVars } = await import('../../src/renderer/shell/theme');
    const { SEEDS } = await import('../../src/shared/theme/seed');
    const theme = xtermThemeFromVars({});
    expect(theme.background).toBe(SEEDS.dark['bg-0']);
    expect(theme.foreground).toBe(SEEDS.dark['text-0']);
    expect(theme.cursor).toBe(SEEDS.dark['accent']);
    expect(theme.selectionBackground).toBe(SEEDS.dark['bg-3']);
    expect(theme.green).toBe(SEEDS.dark['ok']);
    expect(theme.red).toBe(SEEDS.dark['danger']);
    expect(theme.cyan).toBe(SEEDS.dark['series-5']);
  });

  it('the terminal theme from the alias layer agrees with the fallback (the two paths must not diverge)', async () => {
    const { xtermThemeFromVars } = await import('../../src/renderer/shell/theme');
    const fromVars = xtermThemeFromVars(aliasVars('dark'));
    const fromFallback = xtermThemeFromVars({});
    expect(fromVars.background).toBe(fromFallback.background);
    expect(fromVars.foreground).toBe(fromFallback.foreground);
    expect(fromVars.cursor).toBe(fromFallback.cursor);
  });
});
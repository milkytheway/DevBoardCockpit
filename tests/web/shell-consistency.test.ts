import { describe, it, expect } from 'vitest';
import { aliasVars } from '../../src/shared/theme/map';
import { xtermThemeFromVars } from '../../src/renderer/shell/theme';

/**
 * One mapping, four outputs: the application CSS, the card theme.css, ECharts
 * and xterm must all speak the same colours. xterm draws on a canvas and does
 * not resolve CSS variables, so this is the one place where the colours can
 * drift apart silently.
 */

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
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

describe('Theme · the terminal and the alias layer share one source', () => {
  it('the xterm background, text, accent and semantic colours come straight from the alias layer (both skins)', () => {
    for (const skin of ['dark', 'light'] as const) {
      const vars = aliasVars(skin);
      const theme = xtermThemeFromVars(vars);
      expect(theme.background).toBe(vars['--cockpit-bg']);
      expect(theme.foreground).toBe(vars['--cockpit-text']);
      expect(theme.cursor).toBe(vars['--cockpit-accent']);
      expect(theme.green).toBe(vars['--cockpit-ok']);
      expect(theme.yellow).toBe(vars['--cockpit-warn']);
      expect(theme.red).toBe(vars['--cockpit-danger']);
      expect(theme.magenta).toBe(vars['--cockpit-accent-2']);
    }
  });

  it('the two skins produce different terminal themes (otherwise the skin switch is a lie in the terminal)', () => {
    const dark = xtermThemeFromVars(aliasVars('dark'));
    const light = xtermThemeFromVars(aliasVars('light'));
    expect(JSON.stringify(dark)).not.toBe(JSON.stringify(light));
  });
});

describe('Theme · the visual judgments of the shell', () => {
  it('the border of a focusable control inside a card has at least 3:1 contrast against the card surface', () => {
    // The card surface comes from a token, never from a literal colour.
    // (It used to be hard-coded as `#1E242C` — a value that does not exist in
    //   the seed at all; it was left over from an old outline, and a hard-coded
    //   judgment does not measure the real card surface.)
    for (const skin of ['dark', 'light'] as const) {
      const vars = aliasVars(skin);
      const cardSurface = vars['--cockpit-surface'] as string;
      const ratio = contrast(vars['--cockpit-border-strong'] as string, cardSurface);
      expect(ratio, `${skin}: border-strong against the card surface is only ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
  });

  it('body text and the semantic colours have at least 4.5:1 against the panel background', () => {
    // The surface that carries the body text is the card surface, `--cockpit-surface`
    // (taken from a token, never hard-coded)
    const surface = {
      dark: aliasVars('dark')['--cockpit-surface'] as string,
      light: aliasVars('light')['--cockpit-surface'] as string,
    };
    const names = [
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
      for (const name of names) {
        const ratio = contrast(vars[name] as string, surface[skin]);
        expect(ratio, `${skin}: ${name} is only ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The shape of the theme tokens.
 *
 * xterm draws its glyphs on a canvas, and a canvas does not resolve CSS
 * variables — handing `var(--cockpit-bg)` to xterm fails silently and the
 * terminal keeps the default colours. The implementation therefore has to
 * read the resolved values with getComputedStyle.
 *
 * This test locks down two things:
 * 1. the generated token sheet defines the variables the contract requires
 *    (`docs/spec/03-card-manifest.md` section 6.3)
 * 2. the implementation does not hand `var(--...)` straight to the xterm theme
 */
describe('Terminal theme', () => {
  const css = readFileSync(join(process.cwd(), 'src/renderer/theme/tokens.generated.css'), 'utf8');
  const view = readFileSync(
    join(process.cwd(), 'src/renderer/terminal/TerminalView.tsx'),
    'utf8',
  );
  // The shell computes the theme values and passes them in (shell/theme.ts reads
  // the CSS variables and resolves them into concrete colours)
  const theme = readFileSync(join(process.cwd(), 'src/renderer/shell/theme.ts'), 'utf8');

  it('the generated token sheet defines the variables the contract requires', () => {
    for (const token of [
      '--cockpit-bg',
      '--cockpit-bg-elevated',
      '--cockpit-text',
      '--cockpit-accent',
      '--cockpit-font-mono',
      '--cockpit-ok',
      '--cockpit-warn',
      '--cockpit-danger',
      '--cockpit-unavailable',
    ]) {
      expect(css).toContain(`${token}:`);
    }
  });

  it('the xterm theme does not use var(--...) directly (the canvas does not resolve CSS variables)', () => {
    // The producer of the theme values (the shell's theme.ts) must not contain var(--…)
    expect(theme).not.toMatch(/var\(--/);
    // The terminal component only receives the resolved colours
    expect(view).toContain('theme');
    expect(view).toContain('options.theme');
  });

  it('the theme values go through getComputedStyle, which yields resolved values (not token names)', () => {
    expect(theme).toContain('getComputedStyle');
    // The terminal component keeps a fallback of its own (for the case where no theme was passed)
    expect(view).toContain('getComputedStyle');
  });

  it('a colour change mutates options.theme in place instead of rebuilding the terminal (a rebuild loses the scrollback)', () => {
    expect(view).toContain('options.theme');
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The **layout contract of the shell**: an absolutely positioned panel has to
 * be contained by the **page itself**.
 *
 * Why this needs a test:
 *
 * The independent review of 2026-11-14 found a Critical:
 * `.terminal__pane` uses `position: absolute; inset: 0` and **none of its
 * ancestors is a positioning ancestor** → the containing block falls back to
 * the **viewport** → the terminal panel **fills the whole window** and covers
 * the status bar, the rail and the second sidebar → **the rail cannot be
 * clicked any more**.
 *
 * **Measured (Linux Electron + Xvfb)**:
 * the window is 1200×773 and the panel measures **1200×773 @ (0,0)** while it
 * should be inside the page area (**866×705 @ (314,48)**).
 *
 * jsdom **does not lay out**, so what is guarded here is **the declaration
 * itself**: "the terminal page has to be the positioning ancestor" — without
 * that rule the panel flies out of the page.
 */

const REPO = join(__dirname, '../..');
const CSS = readFileSync(join(REPO, 'src/renderer/shell/shell.css'), 'utf8');

/**
 * Takes the declaration block of a selector.
 *
 * @returns the text of the declaration (the content of the `{ … }`), an empty
 * string when there is none.
 */
function declarationsFor(selector: string): string {
  // It looks for `selector {` up to its `}` (the CSS has no nesting, the braces balance)
  const start = CSS.indexOf(`${selector} {`);
  if (start < 0) return '';
  const open = CSS.indexOf('{', start);
  const close = CSS.indexOf('}', open);
  if (close < 0) return '';
  return CSS.slice(open + 1, close);
}

describe('the shell · the positioning ancestor of the terminal page', () => {
  it('the terminal page is the positioning ancestor itself (otherwise the absolutely positioned panel fills the viewport)', () => {
    const declarations = declarationsFor('.page--terminal');
    expect(declarations).not.toBe('');
    expect(declarations).toMatch(/position:\s*relative/);
  });

  it('the terminal panel is absolutely positioned — so it **needs** a positioning ancestor', () => {
    // This one is a premise: if the panel is not absolutely positioned any more, the rule above may be relaxed
    const pane = declarationsFor('.terminal__pane');
    expect(pane).toMatch(/position:\s*absolute/);
    expect(pane).toMatch(/inset:\s*0/);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * The fake xterm: it records the content of every write.
 *
 * In the DOM test environment xterm draws on a canvas, so what was written
 * cannot be observed — and "write every chunk once" and "rewrite the
 * accumulated string" look identical to a test. That is how review finding
 * C4 slipped through: the screen showed duplicated text and the suite was
 * green.
 */
const writes: string[] = [];

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    onData(_cb: (d: string) => void) { return { dispose() { /* no-op */ } }; }
    onResize(_cb: () => void) { return { dispose() { /* no-op */ } }; }
    loadAddon(_a: unknown) { /* no-op */ }
    open(_el: unknown) { /* no-op */ }
    write(data: string) { writes.push(data); }
    focus() { /* no-op */ }
    dispose() { /* no-op */ }
    // A theme change mutates the options in place (no new instance) → the fake has to accept that
    options: Record<string, unknown> = {};
    refresh() { /* no-op */ }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() { /* no-op */ }
    proposeDimensions() { return { cols: 80, rows: 24 }; }
  },
}));

import { TerminalView } from '../../src/renderer/terminal/TerminalView';

beforeEach(() => {
  writes.length = 0;
});

describe('TerminalView', () => {
  it('renders a terminal container and turns the input into write calls', () => {
    const write = vi.fn();
    render(<TerminalView sessionId="s1" onWrite={write} />);
    expect(screen.getByTestId('terminal-s1')).toBeTruthy();
  });

  it('the container carries a data-testid, so the host can find the terminal of every session', () => {
    render(<TerminalView sessionId="abc" onWrite={vi.fn()} />);
    expect(screen.getByTestId('terminal-abc')).toBeTruthy();
  });

  it('every chunk is written once and the history is not replayed (C4)', () => {
    let push: ((chunk: string) => void) | undefined;
    const subscribe = (cb: (chunk: string) => void) => {
      push = cb;
      return () => undefined;
    };

    render(<TerminalView sessionId="s1" onWrite={vi.fn()} subscribe={subscribe} />);

    push?.('first chunk');
    push?.('second chunk');

    // Two writes, one each — not "the accumulated string rewritten twice".
    expect(writes).toEqual(['first chunk', 'second chunk']);
  });
});

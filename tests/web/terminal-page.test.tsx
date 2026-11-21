import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * The fake xterm (the DOM test environment has no canvas ✓).
 */
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    onData(_cb: (d: string) => void) { return { dispose() { /* no-op */ } }; }
    onResize(_cb: () => void) { return { dispose() { /* no-op */ } }; }
    loadAddon(_a: unknown) { /* no-op */ }
    open(_el: unknown) { /* no-op */ }
    write(_data: string) { /* no-op */ }
    focus() { /* no-op */ }
    dispose() { /* no-op */ }
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

import { TerminalPage } from '../../src/renderer/shell/pages/TerminalPage';
import { LocaleContext } from '../../src/renderer/shell/i18n';
import type { TerminalTab } from '../../src/renderer/shell/types';
import type { XtermTheme } from '../../src/renderer/shell/theme';

/** The palette of the terminal ✓ (the test does not look at the colours ✓) */
const THEME: XtermTheme = {
  background: '#000',
  foreground: '#fff',
  cursor: '#fff',
  selectionBackground: '#333',
  black: '#000',
  brightBlack: '#555',
  green: '#0f0',
  brightGreen: '#0f0',
  yellow: '#ff0',
  brightYellow: '#ff0',
  red: '#f00',
  brightRed: '#f00',
  blue: '#00f',
  brightBlue: '#00f',
  cyan: '#0ff',
  brightCyan: '#0ff',
  magenta: '#f0f',
  brightMagenta: '#f0f',
  white: '#fff',
  brightWhite: '#fff',
};

/**
 * **The panes of the terminal page** ✓.
 *
 * → **The page belongs to one board** ✓ (and to the machines ✓) → a session
 *   of **another** board is not on it ✓.
 * → **The active session of another board must not take the pane** ✓ — the
 *   page would show nothing at all ✗ (the pane was filled by a session that
 *   is not on the page ✓ — found on 2026-11-21 ✓).
 */
function renderPage(sessions: TerminalTab[], activeSessionId: string | null): void {
  render(
    // → **The Chinese locale is pinned** ✓ — the empty state is asserted by
    //   its wording ✓ (the wording is the interface's ✓).
    <LocaleContext.Provider value="zh-Hans">
      <TerminalPage
        sessions={sessions}
        activeSessionId={activeSessionId}
        xtermTheme={THEME}
        terminalSubscribe={() => (_cb: (chunk: string) => void) => () => {
          /* no-op */
        }}
        onTerminalWrite={() => undefined}
        onTerminalResize={() => undefined}
        onSelectSession={() => undefined}
        onCloseSession={() => undefined}
      />
    </LocaleContext.Provider>,
  );
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('the terminal page · the panes', () => {
  it('the session of the board that is current is shown', () => {
    renderPage(
      [{ sessionId: 's-real', profileId: 'board-adb', label: 'Board · ADB' }],
      's-real',
    );
    expect(screen.getByText('Board · ADB')).toBeTruthy();
  });

  it('**a session of another board does not take the pane** ✓ (the page would show nothing ✗)', () => {
    // → The page receives **the sessions of this board** ✓ (the shell scopes
    //   them ✓) → but the **active** session is the one the user last opened
    //   ✓ — and it belongs to another board ✓ (the user switched the board ✓)
    //   → it must not fill the pane ✓.
    renderPage(
      [{ sessionId: 's-real', profileId: 'board-adb', label: 'Board · ADB' }],
      's-fake',
    );
    expect(screen.getByText('Board · ADB')).toBeTruthy();
  });

  it('the empty state says so when there is no session', () => {
    renderPage([], null);
    expect(screen.getByText('还没有终端会话')).toBeTruthy();
  });

  it('the first render already shows the terminal bar and the pane (no blank first frame)', () => {
    const html = renderToStaticMarkup(
      <LocaleContext.Provider value="zh-Hans">
        <TerminalPage
          sessions={[{ sessionId: 's-first', profileId: 'board-adb', label: 'Board · ADB' }]}
          activeSessionId="s-first"
          xtermTheme={THEME}
          terminalSubscribe={() => () => () => undefined}
          onTerminalWrite={() => undefined}
          onTerminalResize={() => undefined}
          onSelectSession={() => undefined}
          onCloseSession={() => undefined}
        />
      </LocaleContext.Provider>,
    );
    expect(html).toContain('terminal__bar');
    expect(html).not.toContain('hidden=""');
  });
});

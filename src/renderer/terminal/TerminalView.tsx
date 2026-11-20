import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { readXtermTheme, type XtermTheme } from '../shell/theme';

/**
 * A terminal panel.
 *
 * xterm measures the character width itself (including the wide characters of
 * CJK text and emoji), so **do not compute the column count** — that is the
 * easiest thing to get wrong in terminal rendering.
 * The FitAddon handles resizing; the host only reports the row and column
 * counts back.
 *
 * Every colour comes from a `--cockpit-*` token:
 * changing the theme = changing a set of variable values = every card follows,
 * without rewriting a single card.
 */

export interface TerminalViewProps {
  sessionId: string;
  /** The user types or pastes → the host forwards it to the far end */
  onWrite: (data: string) => void;
  /** On a resize, the row and column counts are reported to the host */
  onResize?: (cols: number, rows: number) => void;
  /**
   * Subscribes to the output of the far end.
   *
   * **It is a callback, not an accumulated string.** With an accumulated
   * string, every chunk means rewriting everything from the first character —
   * the screen would show repeated text instead of what the board said.
   */
  subscribe?: (cb: (chunk: string) => void) => () => void;
  /**
   * The xterm palette (already resolved to concrete colours).
   *
   * **xterm is drawn on a canvas — it cannot resolve `var(--x)`.** So the
   * colours have to be read out of the CSS variables and handed over as
   * plain values.
   *
   * Passing them in (instead of reading them here) means every terminal
   * reads the same snapshot, taken at the same moment — and that a theme
   * change reaches all of them at once.
   */
  theme?: XtermTheme;
  /**
   * Is this the terminal the user is looking at?
   *
   * A hidden terminal must not report its size (the container is 0×0, and
   * FitAddon would measure a fake 2×1). When it becomes visible again it
   * has to re-measure and report, otherwise the remote keeps the old
   * window size.
   */
  active?: boolean;
}

/**
 * Reads the **resolved** value of a CSS variable.
 *
 * xterm draws on a canvas, and a canvas does not understand `var(--x)` —
 * handing xterm the token name fails silently and the terminal falls back to
 * the default colours. So the real colour is read with getComputedStyle.
 */
function readToken(name: string, fallback: string): string {
  if (typeof window === 'undefined' || !window.getComputedStyle) return fallback;
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

/**
 * Measure only when the host really has a box.
 *
 * A pane in a grid transition (or a `display:none` pane) can be measured at
 * 0×0. xterm's renderer then has no dimensions yet and FitAddon throws
 * "Cannot read properties of undefined (reading 'dimensions')". Skipping the
 * measurement is correct: there is nothing to fit until the box exists.
 */
function safeFit(fit: FitAddon, host: HTMLElement): boolean {
  if (host.clientWidth < 20 || host.clientHeight < 20) return false;
  try {
    fit.fit();
    return true;
  } catch {
    return false;
  }
}

export function TerminalView({
  sessionId,
  onWrite,
  onResize,
  subscribe,
  theme,
  active = true,
}: TerminalViewProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onWriteRef = useRef(onWrite);
  const onResizeRef = useRef(onResize);
  const activeRef = useRef(active);

  onWriteRef.current = onWrite;
  onResizeRef.current = onResize;
  activeRef.current = active;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: readToken('--cockpit-font-mono', 'Consolas, monospace'),
      fontSize: 13,
      convertEol: false,
      cursorBlink: true,
      // The board may emit half a UTF-8 character or a bad byte; the terminal
      // handles that itself and must not crash
      scrollback: 2000,
      // **The resolved value has to be read out**: xterm paints the glyphs with
      // the canvas `fillStyle`, and the canvas **does not resolve CSS
      // variables** — passing 'var(--cockpit-bg)' fails silently.
      //
      // The fallback follows **the same path** (`shell/theme.ts` → the seed).
      // This file used to hold a second set of fallback colours from the plan 1
      // era (`#14171c` / `#dfe4ec` / `#58a6ff` / `#1c2027`), side by side
      // with the seed's `#0A0C0F` / `#E6EAF2` / `#58A6FF` / `#1C2129`.
      // Both sets were there and neither had ever been live at the same time —
      // **which is exactly what "it will drift eventually" looks like**.
      theme: theme ?? readXtermTheme(),
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    safeFit(fit, host);
    // **Give the terminal the focus**: otherwise typing right after the tab
    // opens does nothing, and Enter opens yet another tab (the focus is still
    // on a toolbar button).
    term.focus();

    const disposeData = term.onData((data) => {
      onWriteRef.current(data);
    });

    const report = (): void => {
      // **A hidden tab must not report a size**.
      // The panel of an inactive tab is `display:none` → the container is 0×0 →
      // FitAddon measures a tiny size (cols 2 / rows 1 or so).
      // Reporting that size to the remote end ruins the remote window size —
      // and the user is not looking at that tab anyway.
      if (term.cols <= 2 || term.rows <= 1) return;
      onResizeRef.current?.(term.cols, term.rows);
    };

    const observer = new ResizeObserver(() => {
      // **Do not fit while hidden**: the container is 0×0 and FitAddon would
      // measure a fictitious size
      if (!activeRef.current) return;
      if (!safeFit(fit, host)) return;
      report();
    });
    observer.observe(host);

    termRef.current = term;
    fitRef.current = fit;
    report();

    return () => {
      observer.disconnect();
      disposeData.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  // Subscribe to the remote output: write every chunk once, do not replay the
  // history.
  //
  // **The dependency is `subscribe` itself** — the host caches a stable
  // function per session, so this effect does not rerun on every render (a
  // rerun = unsubscribe + resubscribe = the output that arrived in between is
  // lost).
  useEffect(() => {
    if (!subscribe) return;
    return subscribe((chunk: string) => {
      termRef.current?.write(chunk);
    });
  }, [subscribe]);

  // Change the theme: **set `options.theme` in place**, do not rebuild the
  // terminal.
  //
  // Rebuilding it (a different `key`) drops the scrollback as well — changing
  // the theme must not lose the screen.
  // The xterm options are writable (`term.options.theme = {...}`); refresh
  // once afterwards.
  useEffect(() => {
    if (!theme) return;
    const term = termRef.current;
    if (term === null) return;
    term.options.theme = { ...theme };
    term.refresh(0, term.rows - 1);
  }, [theme]);

  // Became visible: measure again and report to the remote end (while it was
  // hidden the remote end stayed at the old size)
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    const host = hostRef.current;
    if (term === null || fit === null || host === null) return;
    if (!safeFit(fit, host)) return;
    if (term.cols > 2 && term.rows > 1) onResizeRef.current?.(term.cols, term.rows);
    term.refresh(0, term.rows - 1);
    term.focus();
  }, [active]);

  return <div className="cockpit-terminal" data-testid={`terminal-${sessionId}`} ref={hostRef} />;
}

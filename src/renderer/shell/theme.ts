import { SEEDS, type ThemeName } from '../../shared/theme/seed';

export type ThemeMode = ThemeName;

const STORAGE_KEY = 'devboard.theme';

export function readStoredTheme(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(mode: ThemeMode): void {
  if (mode === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Local storage can be unavailable in hardened environments; theme is cosmetic.
  }
}

function readVar(name: string, fallback: string): string {
  if (typeof window === 'undefined' || !window.getComputedStyle) return fallback;
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

export interface XtermTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  brightBlack: string;
  green: string;
  brightGreen: string;
  yellow: string;
  brightYellow: string;
  red: string;
  brightRed: string;
  blue: string;
  brightBlue: string;
  cyan: string;
  brightCyan: string;
  magenta: string;
  brightMagenta: string;
  white: string;
  brightWhite: string;
}

/**
 * The fallback palette.
 *
 * ── Why the fallbacks come from the **seed** and not from a second copy of
 * the colours ──
 *
 * This file is the **producer** of the terminal theme. A literal colour value
 * in it means a **second source of truth** — and the terminal really had one:
 * `TerminalView.tsx` carried a set of plan-1 era fallback colours
 * (`#14171c` / `#dfe4ec` / `#58a6ff` / `#1c2027`) alongside the seed values
 * `#0A0C0F` / `#E6EAF2` / `#58A6FF` / `#1C2129`.
 * Both sets were there, they had simply never been active at the same time —
 * **which is exactly what "this will drift eventually" looks like**.
 *
 * → The fallbacks are taken straight from `SEEDS.dark`; **not one colour
 *   value is written by hand here**.
 */
const FALLBACK = SEEDS.dark;

/**
 * xterm draws on canvas and does not resolve CSS variables — read the resolved
 * values. Keeping this in one helper makes the "four outputs, one mapping" rule
 * testable.
 */
export function xtermThemeFromVars(vars: Record<string, string>): XtermTheme {
  // **`||`, not `??`** — a missing variable arrives as an empty string,
  // and `'' ?? fallback` is still `''` (an empty colour silently paints nothing).
  const v = (name: string, fallback: string): string => vars[name] || fallback;
  return {
    background: v('--cockpit-bg', FALLBACK['bg-0']),
    foreground: v('--cockpit-text', FALLBACK['text-0']),
    cursor: v('--cockpit-accent', FALLBACK['accent']),
    selectionBackground: v('--cockpit-surface-active', FALLBACK['bg-3']),
    black: v('--cockpit-bg', FALLBACK['bg-0']),
    brightBlack: v('--cockpit-text-faint', FALLBACK['text-2']),
    green: v('--cockpit-ok', FALLBACK['ok']),
    brightGreen: v('--cockpit-ok', FALLBACK['ok']),
    yellow: v('--cockpit-warn', FALLBACK['warn']),
    brightYellow: v('--cockpit-warn', FALLBACK['warn']),
    red: v('--cockpit-danger', FALLBACK['danger']),
    brightRed: v('--cockpit-danger', FALLBACK['danger']),
    blue: v('--cockpit-accent', FALLBACK['accent']),
    brightBlue: v('--cockpit-accent', FALLBACK['accent']),
    // **cyan is the teal series colour** — `--cockpit-series-3` is amber
    // (#D29922), so binding cyan to it painted amber text in the terminal.
    cyan: v('--cockpit-series-5', FALLBACK['series-5']),
    brightCyan: v('--cockpit-series-5', FALLBACK['series-5']),
    magenta: v('--cockpit-accent-2', FALLBACK['accent-2']),
    brightMagenta: v('--cockpit-accent-2', FALLBACK['accent-2']),
    white: v('--cockpit-text', FALLBACK['text-0']),
    brightWhite: v('--cockpit-text', FALLBACK['text-0']),
  };
}

export function readXtermTheme(): XtermTheme {
  const names = [
    '--cockpit-bg',
    '--cockpit-text',
    '--cockpit-accent',
    '--cockpit-surface-active',
    '--cockpit-text-faint',
    '--cockpit-ok',
    '--cockpit-warn',
    '--cockpit-danger',
    '--cockpit-series-5',
    '--cockpit-accent-2',
  ];
  const vars: Record<string, string> = {};
  for (const name of names) vars[name] = readVar(name, '');
  return xtermThemeFromVars(vars);
}

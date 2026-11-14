import type { ThemeName } from '../../shared/theme/seed';

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
  yellow: string;
  red: string;
  blue: string;
  cyan: string;
  magenta: string;
  white: string;
  brightWhite: string;
}

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
    background: v('--cockpit-bg', '#0A0C0F'),
    foreground: v('--cockpit-text', '#E6EAF2'),
    cursor: v('--cockpit-accent', '#58A6FF'),
    selectionBackground: v('--cockpit-surface-active', '#1C2129'),
    black: v('--cockpit-bg', '#0A0C0F'),
    brightBlack: v('--cockpit-text-faint', '#8B95A5'),
    green: v('--cockpit-ok', '#3FB950'),
    yellow: v('--cockpit-warn', '#D29922'),
    red: v('--cockpit-danger', '#F85149'),
    blue: v('--cockpit-accent', '#58A6FF'),
    // **cyan is the teal series colour** — `--cockpit-series-3` is amber
    // (#D29922), so binding cyan to it painted amber text in the terminal.
    cyan: v('--cockpit-series-5', '#39C5BB'),
    magenta: v('--cockpit-accent-2', '#A371F7'),
    white: v('--cockpit-text', '#E6EAF2'),
    brightWhite: v('--cockpit-text', '#E6EAF2'),
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

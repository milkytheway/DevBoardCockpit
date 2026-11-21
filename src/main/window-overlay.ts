import { SEEDS } from '../shared/theme/seed';

/** Height of the native window-controls overlay (kept in sync with visual.css). */
export const TITLEBAR_HEIGHT = 40;

/**
 * Transparent native controls let the shell's own title-row gradient continue
 * behind min / max / close instead of ending in a solid rectangular strip.
 */
export function titleBarOverlay(theme: 'dark' | 'light'): {
  color: string;
  symbolColor: string;
  height: number;
} {
  const seed = SEEDS[theme];
  return {
    color: '#00000000',
    symbolColor: seed['text-0'],
    height: TITLEBAR_HEIGHT,
  };
}

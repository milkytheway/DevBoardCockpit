import { describe, expect, it } from 'vitest';
import { titleBarOverlay } from '../../src/main/window-overlay';

describe('the native window-control overlay', () => {
  it('is transparent so the shell gradient continues behind min / max / close', () => {
    for (const theme of ['dark', 'light'] as const) {
      expect(titleBarOverlay(theme).color).toBe('#00000000');
    }
  });

  it('keeps readable symbols and the same height as the shell title row', () => {
    const dark = titleBarOverlay('dark');
    const light = titleBarOverlay('light');
    expect(dark.symbolColor).not.toBe(light.symbolColor);
    expect(dark.height).toBe(40);
    expect(light.height).toBe(40);
  });
});

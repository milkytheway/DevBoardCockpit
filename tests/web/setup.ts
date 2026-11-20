import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Unmount the rendered components after every test — otherwise several renders
// in one file pile up and getByTestId finds several elements with the same name.
afterEach(() => {
  cleanup();
});

/**
 * The test environment lacks xterm and the browser APIs our components need:
 *
 * - `window.matchMedia` — xterm uses it to decide whether Unicode widths are supported
 * - `HTMLCanvasElement.prototype.getContext` — the xterm renderer; the DOM implementation has no canvas
 * - `ResizeObserver` — we use it to watch the size of the terminal container
 *
 * The canvas and the ResizeObserver here are empty implementations.
 * What the test checks is that the component mounts and wires its events, not the
 * pixel rendering of the terminal. The real rendering is covered by the
 * real-device acceptance checklist.
 */
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

if (!HTMLCanvasElement.prototype.getContext) {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe(): void {
      /* The DOM implementation does not lay out; the test triggers resizes explicitly */
    }
    unobserve(): void {
      /* no-op */
    }
    disconnect(): void {
      /* no-op */
    }
  } as unknown as typeof ResizeObserver;
}

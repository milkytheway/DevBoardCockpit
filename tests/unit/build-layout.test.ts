import { describe, it, expect } from 'vitest';
import {
  PRELOAD_ENTRY,
  PRELOAD_FILE,
  PRELOAD_FORMAT,
  preloadEntryName,
} from '../../src/shared/build-layout';

/**
 * The naming contract of the artefact of the preload.
 *
 * The cost of this contract is **a whole chain of silent failures**:
 *
 *   the main refers to `../preload/index.js`
 *     → the build really produces `index.mjs` (because the package.json is
 *       `"type": "module"`)
 *       → the preload fails to load and `window.cockpit` is undefined
 *         → the renderer has no API at all and the interface stays at "pick a
 *           connection to start"
 *
 * Every link of the chain looks "normal" during the development: the build
 * succeeds, the type check passes, the tests are green. It is only exposed
 * when the window is really opened. Therefore it has to be guarded **by the
 * machine** and not by the memory of a person.
 *
 * The two guards:
 * 1. here — the names match and the format has to be CJS (a sandboxed
 *    preload cannot run ESM).
 * 2. `scripts/check-build.ts` — after the build it verifies that the artefact
 *    is really there and really CJS.
 */
describe('the naming of the artefact of the preload', () => {
  it('the name of the build artefact and the name the main refers to are the same', () => {
    expect(preloadEntryName('index')).toBe(PRELOAD_FILE);
  });

  it('the preload has to be built as CommonJS — a sandboxed preload cannot run ESM', () => {
    // An ESM preload needs `sandbox: false`, and that means turning off the sandbox of the renderer.
    // And the renderer hosts the cards that are not trusted, so the sandbox is the last line of defence.
    expect(PRELOAD_FORMAT).toBe('cjs');
  });

  it('the artefact uses the .cjs suffix — `.cjs` is CommonJS in every case', () => {
    // The meaning of `.js` depends on the `type` of the nearest package.json;
    // `.cjs` is CommonJS wherever it goes.
    expect(PRELOAD_ENTRY.endsWith('.cjs')).toBe(true);
    expect(PRELOAD_FILE.endsWith('.cjs')).toBe(true);
  });
});

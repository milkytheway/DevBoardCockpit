import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { PRELOAD_ENTRY, PRELOAD_FORMAT } from './src/shared/build-layout';

/**
 * The preload has to be built as **CommonJS**.
 *
 * electron-vite picks the format from the `type` field of `package.json`.
 * This project is `"type": "module"`, so the preload would come out as ESM
 * (`index.mjs`). But **a sandboxed preload in Electron can only run
 * CommonJS** (the official documentation states it: sandboxed preload scripts
 * cannot use ESM imports). An ESM preload forces `sandbox: false`, which
 * switches the renderer sandbox off — and the renderer hosts untrusted cards,
 * so that sandbox is the last line of defence.
 *
 * Hence `format: 'cjs'` and `entryFileNames: '[name].cjs'` are pinned here.
 * The file name is not arbitrary: `src/shared/build-layout.ts` is the single
 * source of it, and the preload path in main is taken from the same place, so
 * the two cannot disagree. `scripts/check-build.ts` runs at the end of
 * `npm run build` and checks that the artefact really exists.
 */
export default defineConfig(() => ({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      /**
       * The fake device **ships in the production build** ✓
       * (the user decided it on 2026-11-21 ✓).
       *
       * → **It is synthetic data** ✓ — the interface says so on every screen
       *   it appears on ✓ (the terminal banner ✓ · the board name ✓).
       * → **The real board comes first** ✓ (`hal/fake/wiring.ts` ✓) — the
       *   default selection is the real one ✓.
       * → `COCKPIT_FAKE=off` turns it off ✓ · `COCKPIT_FAKE=only` leaves
       *   only the fake ✓.
       *
       * → **The build self-check asserts the opposite of what it used to** ✓:
       *   the marker **has** to be in the bundle ✓ (`scripts/check-build.ts` ✓).
       */
      __COCKPIT_FAKE_BUILD__: JSON.stringify(true),
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: {
          format: PRELOAD_FORMAT,
          entryFileNames: PRELOAD_ENTRY,
          chunkFileNames: '[name]-[hash].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer'),
      },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
}));

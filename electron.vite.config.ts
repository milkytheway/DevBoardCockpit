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
export default defineConfig(({ command, mode }) => ({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      /**
       * ⚠️ The fake device is **only in a debug build**:
       * the production build compiles this to `false`,
       * so `if (!__COCKPIT_FAKE_BUILD__) return;` becomes dead code,
       * rollup drops the whole block — **and the dynamic import's chunk
       * is never emitted** (`scripts/check-build.ts` verifies this:
       * the marker string must not appear anywhere under `out/main/`).
       *
       * ── The two builds that carry the fake device ──
       *
       * | Build | Command | Fake device in the bundle |
       * |---|---|---|
       * | Production | `npm run build` | **No** (this is exactly what the self-check verifies) |
       * | Debug | `npm run build:fake` (`--mode fake`) | **Yes** |
       * | Development server | `npm run dev` | Yes |
       *
       * → **Why a build that carries the fake device**: the e2e suite needs a
       *   **fake board that answers actions** (a production build has no fake
       *   device, so the action criterion cannot be automated).
       * → That build **does not run `scripts/check-build.ts`** (the self-check
       *   exists precisely to verify that the fake device is absent).
       */
      __COCKPIT_FAKE_BUILD__: JSON.stringify(command !== 'build' || mode === 'fake'),
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

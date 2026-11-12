import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { PRELOAD_ENTRY, PRELOAD_FORMAT } from './src/shared/build-layout';

/**
 * preload 必须构建成 **CommonJS**。
 *
 * electron-vite 默认看 `package.json` 的 `type` 决定格式——本工程是
 * `"type": "module"`，于是它把 preload 产成 ESM（`index.mjs`）。
 * 但 **Electron 的沙箱 preload 只能跑 CommonJS**
 * （官方文档：Sandboxed preload scripts can't use ESM imports）。
 * ESM preload 必须 `sandbox: false`，那等于关掉渲染进程沙箱——
 * 而渲染进程里要装不可信的卡片，沙箱是最后一道防线。
 *
 * 所以这里钉死 `format: 'cjs'` + `entryFileNames: '[name].cjs'`。
 * 文件名不是随手写的：`src/shared/build-layout.ts` 是唯一出处，
 * main 里的 preload 路径也从那里取，两边不会对不上。
 * `npm run build` 末尾的 `scripts/check-build.ts` 会再验一次产物真的存在。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
});

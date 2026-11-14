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
       * ── 两档「带假设备的构建」──
       *
       * | 构建 | 命令 | 假设备在包里吗 |
       * |---|---|---|
       * | 生产 | `npm run build` | **不在**（自检脚本验的就是这件事） |
       * | 调试 | `npm run build:fake`（`--mode fake`） | **在** |
       * | 开发服务器 | `npm run dev` | 在 |
       *
       * → **为什么要「带假设备的构建」**：e2e 要一块**能应答动作的假板子**
       * （生产构建里没有假设备 → 动作那条判据没法自动化）。
       * → 那条构建**不走 `scripts/check-build.ts`**（自检要验的正是「假设备不在包里」）。
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

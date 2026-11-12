import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.{test,spec}.ts', 'tests/integration/**/*.{test,spec}.ts'],
        },
      },
      {
        test: {
          name: 'web',
          // happy-dom 比 jsdom 快一个量级（jsdom 每个文件建一次环境要 23 秒）。
          // 我们只需要基本 DOM + matchMedia + ResizeObserver，happy-dom 都给。
          environment: 'happy-dom',
          include: ['tests/web/**/*.{test,spec}.{ts,tsx}'],
          setupFiles: [resolve(__dirname, 'tests/web/setup.ts')],
          // **不要**设 isolate:false。共享一份 jsdom 环境会让
          // vi.mock 的模块替身在文件之间串——terminal-view 的
          // 「记录 write」数组会被别的文件清空，测试变成偶发红。
          // 宁可慢，也不要一个会飘的红。
        },
      },
    ],
  },
});

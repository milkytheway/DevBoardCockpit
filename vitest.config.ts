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
          environment: 'jsdom',
          include: ['tests/web/**/*.{test,spec}.{ts,tsx}'],
          setupFiles: [resolve(__dirname, 'tests/web/setup.ts')],
          // jsdom 环境每个文件建一次要 ~23 秒（沙箱文件系统慢）。
          // 同一个 worker 里共享一份环境，省掉重复的构造开销。
          isolate: false,
        },
      },
    ],
  },
});

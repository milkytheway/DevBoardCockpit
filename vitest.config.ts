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
          // happy-dom is an order of magnitude faster than jsdom (jsdom takes
          // 23 seconds to build one environment per test file).
          // All we need is a basic DOM plus matchMedia and ResizeObserver, and
          // happy-dom has all of them.
          environment: 'happy-dom',
          include: ['tests/web/**/*.{test,spec}.{ts,tsx}'],
          setupFiles: [resolve(__dirname, 'tests/web/setup.ts')],
          // **Do not** set isolate:false. One shared jsdom environment lets
          // the module doubles of vi.mock leak from one file to the next —
          // the "record write" array of terminal-view is cleared by another
          // file, and the tests turn intermittently red.
          // Better slow than an intermittent red.
        },
      },
    ],
  },
});

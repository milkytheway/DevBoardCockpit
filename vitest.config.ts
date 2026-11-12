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
        },
      },
    ],
  },
});

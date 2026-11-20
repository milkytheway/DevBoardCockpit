import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      '.superpowers/**',
      '.work/**',
      'docs/**',
      // The one-shot scripts and the intermediate artefacts of the release cleanup.
      './*.cjs',
      './*.mjs',
      './*.ts',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: { console: 'readonly', process: 'readonly', window: 'readonly', document: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly' },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-undef': 'off',
    },
  },
  {
    // A `.cjs` file is CommonJS by definition — it is configured apart from
    // `.mjs`, because writing sourceType "module" for it would report the
    // legal CJS constructs (a top-level return, sloppy mode) as parse errors.
    files: ['**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
  },
  {
    // The scripts are plain Node (.mjs); they run at the repository root and
    // never in a browser or in Electron.
    // They use console / process / setTimeout — those are globals in Node.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      // The Node 22 globals: fetch and WebSocket are built in
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
  },
  {
    // **The code of the cards themselves** (`cards/**`, the built-in cards of
    // the product) runs in a **sandboxed iframe in the browser**: it has
    // document / window / timers; `cockpit` is **injected by the host**
    // (contract section 7).
    files: ['cards/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        document: 'readonly',
        window: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        // The capabilities the host injects (the allow list of contract section 7)
        cockpit: 'readonly',
      },
    },
  },
];

#!/usr/bin/env node
/**
 * Clear `out/` before a build.
 *
 * **Why it has to be cleared**: electron-vite **does not clear** `out/preload/`.
 * So `out/preload/index.cjs` from the previous build survives, and the build
 * artefact self-check reads **exactly that stale file** — even when this build
 * really produced the ESM `index.mjs`, the self-check still prints "passed".
 *
 * That self-check guards the P0 of the previous round (the wrong preload path)
 * — **a guard that a stale artefact can fool is not a guard**.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const out = join(process.cwd(), 'out');
rmSync(out, { recursive: true, force: true });
console.log('cleared out/ (a stale artefact must not fool the build self-check)');

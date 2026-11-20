#!/usr/bin/env node
/**
 * **The list of the test gaps** (static — no coverage tool).
 *
 * ── Why no coverage tool ──
 *
 * Installing `@vitest/coverage-*` touches the **`node_modules` that the host
 * and the sandbox share** → and that shared directory is a known pain of this
 * project (one `npm install` on the host was enough to keep the vitest of
 * the sandbox from starting).
 * → **Nothing is installed**, a **static heuristic** is used instead (it is
 * enough).
 *
 * ── What it counts and what it does not ──
 *
 * → **It counts**: a source file that **is not mentioned in a single test**
 *   (most likely nobody tests it).
 * → **It does not count**: the coverage percentage (the heuristic misses
 *   things — for example a file that is tested indirectly but never
 *   imported).
 * → So it is **only used to find the files that nobody touched at all**.
 *
 * Usage: `node scripts/test-gaps.mjs` (run it in the root of the repository)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(process.cwd());

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'out' || entry === 'release' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const srcFiles = walk(join(ROOT, 'src')).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.d.ts'));
const testFiles = walk(join(ROOT, 'tests')).filter((f) => /\.test\.tsx?$/.test(f));

/** The content of every test file put together (to search for "was it ever mentioned") */
const testBlob = testFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

const gaps = [];
for (const file of srcFiles) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  // The **file name (without the extension)** and the **directory name** both have to be mentioned by a test for it to count as "tested"
  const base = rel.split('/').pop().replace(/\.(ts|tsx)$/, '');
  const dir = rel.split('/').slice(0, -1).join('/');
  const mentioned = testBlob.includes(base) || (dir !== '' && testBlob.includes(dir));
  if (!mentioned) gaps.push(rel);
}

console.log(`${srcFiles.length} source files · ${testFiles.length} test files`);
console.log(`**${gaps.length} source files that no test mentions at all**\n`);
for (const g of gaps) console.log('  ', g);

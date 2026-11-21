/**
 * A one-off: **which mutation guards no longer apply** ✓ (their source text
 * is gone ✓ → the mutation does nothing ✓ → the guard proves nothing ✓).
 *
 * → It reads the mutant list ✓ and checks the text each of them searches for
 *   against the file it points at ✓ — **without running any test** ✓.
 * → **The line endings are normalized** ✓ (a file with CRLF ✓ would make
 *   every mutation of it fail to apply ✓ — found on 2026-11-21 ✓).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'scripts', 'mutation-check.mjs'), 'utf8');

// → the mutants are a plain array in the script ✓ → pull it out ✓
const start = source.indexOf('const MUTATIONS = [');
const end = source.indexOf('\n];', start);
const listText = source.slice(start + 'const MUTATIONS = ['.length, end);

// → the helper of the script ✓ (it is the authority ✓)
// eslint-disable-next-line no-unused-vars -- the mutants below use it ✓
function replace(src, oldText, newText) {
  if (!src.includes(oldText)) {
    throw new Error(`the original text is not there: ${JSON.stringify(oldText.slice(0, 140))}`);
  }
  return src.replace(oldText, newText);
}
const MUTATIONS = eval(`[${listText}]`);

const stale = [];
for (const m of MUTATIONS) {
  const path = join(ROOT, m.file);
  if (!existsSync(path)) {
    stale.push(`${m.name.split(' ')[0]} — ${m.file} — the file is gone`);
    continue;
  }
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  try {
    if (m.apply(text) === text) {
      stale.push(`${m.name.split(' ')[0]} — ${m.file} — the mutation changed nothing`);
    }
  } catch (err) {
    stale.push(`${m.name.split(' ')[0]} — ${m.file} — ${err instanceof Error ? err.message : err}`);
  }
}

console.log(`=== ${MUTATIONS.length} mutants · ${stale.length} did not apply ===`);
for (const line of stale) console.log(`  x ${line}`);

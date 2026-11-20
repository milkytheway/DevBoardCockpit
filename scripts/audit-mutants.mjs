#!/usr/bin/env node
/**
 * **Static audit: does every mutation's `oldText` still match?**
 *
 * ── Why this exists ──
 *
 * → **A mutation guard can rot silently** (`oldText` no longer matches → the
 *   script reports "the original text is not there" → **that entry no longer
 *   tests anything**).
 * → **And it takes the whole round down with it** (`readFileSync` throws ENOENT
 *   → **no later guard runs at all**).
 * → **So run this whenever the code changes** (**far cheaper than a full run**
 *   — a full run takes tens of minutes).
 *
 * Usage: `node scripts/audit-mutants.mjs` (**a non-zero exit code means a
 * guard has already gone stale**).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const src = readFileSync('scripts/mutation-check.mjs', 'utf8');
const start = src.indexOf('const MUTATIONS = [');
const end = src.indexOf('\n];\n', start);
const arrText = src.slice(src.indexOf('[', start), end + 2);
const helper = (s2, a, b) => {
  if (!s2.includes(a)) throw new Error(`the original text is not there: ${a.slice(0, 60)}`);
  return s2.replace(a, b);
};
const list = new Function('replace', `return (${arrText});`)(helper);
let bad = 0;
for (const mut of list) {
  const p = join(process.cwd(), mut.file);
  if (!existsSync(p)) { console.log('the file is gone:', mut.name, '->', mut.file); bad++; continue; }
  const original = readFileSync(p, 'utf8');
  try { mut.apply(original); }
  catch (e) { console.log('the mutation did not apply:', mut.name, '->', String(e.message).slice(0, 70)); bad++; }
}
console.log('total', list.length, 'broken', bad);
process.exit(bad > 0 ? 1 : 0);

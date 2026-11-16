#!/usr/bin/env node
/**
 * **静态排查：每个变异的 `oldText` 现在还对得上吗** ✓
 *
 * ── 为什么要有这个 ──
 *
 * → **变异守卫会静默地烂** ✓（`oldText` 对不上 ✓ → 脚本报「原文不在」✓
 *   → **那一项其实已经不测任何东西** ✗）。
 * → **而且它会让整轮跑到那里就崩** ✗（`readFileSync` 抛 ENOENT ✓ → **后面的守卫一个都跑不到** ✗）。
 * → **所以每次改了代码要顺手跑一遍这个** ✓（**比跑全量快得多** ✓ —— 全量要几十分钟 ✗）。
 *
 * 用法：`node scripts/audit-mutants.mjs` ✓（**退出码非 0 = 有守卫已经失效** ✓）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const src = readFileSync('scripts/mutation-check.mjs', 'utf8');
const start = src.indexOf('const MUTATIONS = [');
const end = src.indexOf('\n];\n', start);
const arrText = src.slice(src.indexOf('[', start), end + 2);
const helper = (s2, a, b) => {
  if (!s2.includes(a)) throw new Error(`原文不在：${a.slice(0, 60)}`);
  return s2.replace(a, b);
};
const list = new Function('replace', `return (${arrText});`)(helper);
let bad = 0;
for (const mut of list) {
  const p = join(process.cwd(), mut.file);
  if (!existsSync(p)) { console.log('文件没了:', mut.name, '->', mut.file); bad++; continue; }
  const original = readFileSync(p, 'utf8');
  try { mut.apply(original); }
  catch (e) { console.log('变异没打上:', mut.name, '->', String(e.message).slice(0, 70)); bad++; }
}
console.log('总数', list.length, '有问题', bad);
process.exit(bad > 0 ? 1 : 0);

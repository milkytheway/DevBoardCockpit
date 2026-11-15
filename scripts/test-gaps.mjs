#!/usr/bin/env node
/**
 * **测试缺口清单**（静态的 ✓ —— 不用覆盖率工具 ✓）。
 *
 * ── 为什么不用覆盖率工具 ──
 *
 * 装 `@vitest/coverage-*` 会动**宿主与沙箱共用的 `node_modules`** ✓ →
 * 而那个共享目录是本工程已知的痛点 ✓（一次宿主 `npm install` 就让沙箱的 vitest 起不来 ✓）。
 * → **不装** ✓，改用**静态启发式** ✓（够用 ✓）。
 *
 * ── 它算什么，不算什么 ──
 *
 * → **算** ✓：某个源文件**在测试里一个字都没被提到** ✓（很可能没人测它 ✓）。
 * → **不算** ✓：覆盖率百分比 ✓（启发式会漏 ✓ —— 比如一个文件被间接测到但没被 import ✓）。
 * → 所以它**只用来找「完全没人碰过」的文件** ✓ ✓。
 *
 * 用法：`node scripts/test-gaps.mjs`（在仓库根跑 ✓）
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

/** 所有测试文件的内容拼起来（用来搜「有没有提到过」） */
const testBlob = testFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

const gaps = [];
for (const file of srcFiles) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  // **文件名（去扩展名）** 与 **目录名** 都要被测试提到过，才算「有测试」✓
  const base = rel.split('/').pop().replace(/\.(ts|tsx)$/, '');
  const dir = rel.split('/').slice(0, -1).join('/');
  const mentioned = testBlob.includes(base) || (dir !== '' && testBlob.includes(dir));
  if (!mentioned) gaps.push(rel);
}

console.log(`源文件 ${srcFiles.length} 个 · 测试文件 ${testFiles.length} 个`);
console.log(`**完全没被测试提到过**的源文件：${gaps.length} 个\n`);
for (const g of gaps) console.log('  ', g);

#!/usr/bin/env node
/**
 * 构建前清空 `out/`。
 *
 * **为什么必须清**：electron-vite **不清空** `out/preload/`。
 * 于是上一次构建留下的 `out/preload/index.cjs` 会活下来，
 * 而构建产物自检读的**正是这个陈旧文件**——
 * 哪怕本次构建真的产出了 ESM 的 `index.mjs`，自检也会打印「✓ 通过」。
 *
 * 那道自检守的正是上一轮的 P0（preload 路径错）——
 * **守卫被陈旧产物骗过，就等于没有守卫**。
 * （`docs/13-计划1复评报告.md` S-01）
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const out = join(process.cwd(), 'out');
rmSync(out, { recursive: true, force: true });
console.log('已清空 out/（避免陈旧产物骗过构建自检）');

#!/usr/bin/env node
/**
 * 装依赖后的**原生模块自检**：加载不了才编译。
 *
 * ── 为什么不直接跑 `electron-rebuild` ──
 *
 * `node-pty` 与 `serialport` 都是 **NAPI** 模块
 * （导出表里有 `napi_register_module_v1`；NAPI 不绑定 Node/Electron 的 ABI 版本），
 * 所以**包自带的 prebuilds 跨 Node 与 Electron 版本通用**——
 * 「为 Electron 重编译」这件事对它们是多余的。
 *
 * 而 electron-rebuild 对这两个包**每次都从源码重编**，原因是各不相同的：
 *
 * | 包 | 为什么跳过判据落空 |
 * |---|---|
 * | `node-pty` | 它的 `package.json` 的 devDependencies **没有** `prebuildify` → electron-rebuild 的 `usesTool()` 判 false → prebuildify 那条探测根本不跑 |
 * | `@serialport/bindings-cpp` | 有 `prebuildify`，但它找的是 `electron.napi.node` / `node.napi.node` / `electron.abi<N>.node`，而实际文件叫 `@serialport+bindings-cpp.node` → 找不到 |
 *
 * （electron-rebuild **是**认 prebuildify 布局的，
 * `lib/module-rebuilder.js:140` 那个跳过判据里也**没有** `force`——
 * 也就是说 `-f` 并不是根因。上面的两个才是。）
 *
 * 代价是一条**整条工具链**：node-gyp 要 Python、要 MSVC，
 * 而 node-pty 的 `binding.gyp` 硬写了 `SpectreMitigation: 'Spectre'`——
 * 缺它就 MSB8040（**VS2022 也不带 Spectre 库**）。
 *
 * 于是「干净克隆一台 Windows」本来只需要 Node，却被 postinstall 逼着装
 * Python + Build Tools + 1.6 GB 的 VS。
 *
 * ── 这个脚本的判据 ──
 *
 * **原生二进制在不在，而且加载得了不**。
 *
 * ⚠️ **不能只看 `require('node-pty')` 成功与否**：
 * node-pty 在 **Windows 分支下 require 时根本不碰原生模块**
 * （`lib/index.js` 的 win32 分支只加载 JS，原生模块是 `spawn()` 时才懒加载）——
 * 所以**一个原生二进制都没有时 `require` 也成功**，
 * 用它当判据会得出「都能加载 → 不用编译」的错误结论。
 *
 * 所以这里**直接找二进制文件**（node-gyp-build 的查找顺序：
 * `build/Release` → `build/Debug` → `prebuilds/<platform>-<arch>`），
 * **再真的 require 它一次**——加载失败（架构不对、文件损坏）才算数。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** 要检查的原生模块：包目录 + 二进制文件名 */
const MODULES = [
  { name: 'node-pty', dir: 'node_modules/node-pty', binary: 'pty.node' },
  {
    name: 'serialport',
    dir: 'node_modules/@serialport/bindings-cpp',
    binary: '@serialport+bindings-cpp.node',
  },
];

/**
 * 按 node-gyp-build 的顺序找原生二进制。
 *
 * **返回绝对路径**——`require` 收到相对路径会当成模块 id 去 node_modules 里找，
 * 报「Cannot find module 'node_modules/...'」（看起来像文件没了，其实是路径没解析）。
 */
function findBinary(dir, binary) {
  const candidates = [
    join(dir, 'build', 'Release', binary),
    join(dir, 'build', 'Debug', binary),
    join(dir, 'prebuilds', `${process.platform}-${process.arch}`, binary),
  ];
  for (const p of candidates) if (existsSync(p)) return resolve(p);

  // 名字对不上时，退而求其次：那个平台目录里的任意 .node
  const prebuildDir = join(dir, 'prebuilds', `${process.platform}-${process.arch}`);
  if (existsSync(prebuildDir)) {
    const any = readdirSync(prebuildDir).find((f) => f.endsWith('.node'));
    if (any) return resolve(join(prebuildDir, any));
  }
  return null;
}

/** 二进制在**且**加载得了 → 没问题 */
function probe(mod) {
  const path = findBinary(mod.dir, mod.binary);
  if (!path) return { ok: false, why: `找不到原生二进制（${mod.binary}）` };
  try {
    require(path);
    return { ok: true, path };
  } catch (err) {
    const msg = String(err && err.message ? err.message : err).split('\n')[0];
    return { ok: false, why: `原生二进制加载失败：${msg}`, path };
  }
}

const broken = [];
for (const mod of MODULES) {
  const r = probe(mod);
  if (r.ok) {
    console.log(`[原生模块] ${mod.name} ✓  ${r.path.replace(process.cwd(), '.')}`);
  } else {
    broken.push({ mod, why: r.why });
    console.log(`[原生模块] ${mod.name} ✗  ${r.why}`);
  }
}

if (broken.length === 0) {
  console.log('[原生模块] 都能用 —— 不需要编译器，跳过重编译。');
  console.log('  （两个包都是 NAPI 的，包自带 prebuilds 跨 Node/Electron 版本通用。）');
  process.exit(0);
}

console.log('[原生模块] 从源码编译（这一步需要 Python + C++ 编译器）……');

const res = spawnSync(
  'npx',
  ['electron-rebuild', '-f', '-w', broken.map((b) => b.mod.name).join(',')],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);

if (res.status === 0) {
  const still = broken.filter((b) => !probe(b.mod).ok);
  if (still.length === 0) {
    console.log('[原生模块] 编译完成，都能用了。');
    process.exit(0);
  }
  console.error(`[原生模块] 编译完了但还是不能用：${still.map((b) => b.mod.name).join(', ')}`);
  for (const b of still) console.error(`  ${b.mod.name}: ${probe(b.mod).why}`);
  process.exit(1);
}

console.error('[原生模块] 编译失败。');
console.error('  没有 C++ 编译器的话装不了——但应用仍能启动：');
console.error('  只有「本机」通道的 pty 会用不了，串口 / ADB / SSH 三条通道不受影响。');
console.error('  装编译器：Windows 上装 Visual Studio Build Tools 的「使用 C++ 的桌面开发」工作负载。');
process.exit(0);

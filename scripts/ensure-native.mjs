#!/usr/bin/env node
/**
 * 装依赖后的**原生模块自检**：加载不了才编译。
 *
 * ── 为什么不是直接跑 `electron-rebuild -f` ──
 *
 * `node-pty` 与 `serialport` 都是 **NAPI** 模块
 * （导出表里有 `napi_register_module_v1`，NAPI 不绑定 Node/Electron 的 ABI 版本），
 * 所以**包自带的 prebuilds 跨 Node 与 Electron 版本通用**。
 *
 * 而 `electron-rebuild` 的跳过判据只看 **prebuild-install** 布局
 * （`lib/module-rebuilder.js:69` → `prebuildInstall.prebuiltModuleExists()`），
 * **认不出 prebuildify 布局**（`prebuilds/<platform>/<file>.node`）——
 * 所以它对这两个模块**每次都会从源码重编**。
 * 带 `-f` 更是明写「Force rebuilding modules, even if we would skip it otherwise」。
 *
 * 代价是一条**整条工具链**：node-gyp 要 Python、要 MSVC，
 * 而 node-pty 的 `binding.gyp` 硬写了 `SpectreMitigation: 'Spectre'`——
 * 缺它就 MSB8040（**VS2022 也不带 Spectre 库**）。
 *
 * 于是「干净克隆一台 Windows」本来只需要 Node，
 * 却被 `postinstall` 逼着装 Python + Build Tools + 1.6 GB 的 VS。
 *
 * ── 这个脚本的判据 ──
 *
 * **能不能加载**。能加载（Windows / macOS 有 prebuild）→ 什么都不做，
 * 不需要任何编译器；加载不了（Linux 没有 node-pty 的 prebuild）→ 才编译。
 *
 * 顺便把「为什么需要编译」讲清楚——
 * 不然出错时看到的是一屏 node-gyp 日志，看不出是哪一步。
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const MODULES = ['node-pty', 'serialport'];
const require = createRequire(import.meta.url);

function canLoad(name) {
  try {
    require(name);
    return true;
  } catch {
    return false;
  }
}

function whyNot(name) {
  try {
    require(name);
    return '';
  } catch (err) {
    return String(err && err.message ? err.message : err).split('\n')[0];
  }
}

const broken = MODULES.filter((m) => !canLoad(m));

if (broken.length === 0) {
  console.log('[原生模块] 都能加载 —— 不需要编译器，跳过重编译。');
  console.log('  （两个包都是 NAPI 的，包自带 prebuilds 跨 Node/Electron 版本通用。）');
  process.exit(0);
}

console.log(`[原生模块] 加载不了：${broken.join(', ')}`);
for (const m of broken) console.log(`  ${m}: ${whyNot(m)}`);
console.log('[原生模块] 从源码编译（这一步需要 Python + C++ 编译器）……');

const res = spawnSync(
  'npx',
  ['electron-rebuild', '-f', '-w', broken.join(',')],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);

if (res.status === 0) {
  const stillBroken = broken.filter((m) => !canLoad(m));
  if (stillBroken.length === 0) {
    console.log('[原生模块] 编译完成，都能加载了。');
    process.exit(0);
  }
  console.error(`[原生模块] 编译完了但还是加载不了：${stillBroken.join(', ')}`);
  for (const m of stillBroken) console.error(`  ${m}: ${whyNot(m)}`);
  process.exit(1);
}

console.error('[原生模块] 编译失败。');
console.error('  没有 C++ 编译器的话装不了——但应用仍能启动：');
console.error('  只有「本机」通道的 pty 会用不了，串口 / ADB / SSH 三条通道不受影响。');
console.error('  装编译器：Windows 上装 Visual Studio Build Tools 的「使用 C++ 的桌面开发」工作负载。');
process.exit(0);

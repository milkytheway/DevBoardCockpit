#!/usr/bin/env node
/**
 * The **self-check of the native modules** after the dependencies are
 * installed: only a module that does not load is compiled.
 *
 * ── Why `electron-rebuild` is not run right away ──
 *
 * `node-pty` and `serialport` are both **NAPI** modules
 * (their export table holds `napi_register_module_v1`; NAPI is not bound to
 * the ABI version of Node or Electron), so **the prebuilds that ship with the
 * package work across the Node and the Electron versions** — "rebuilding for
 * Electron" is redundant for them.
 *
 * electron-rebuild, on the other hand, **recompiles both of them from the
 * source every time**, for reasons that differ:
 *
 * | Package | Why the skip criterion misses |
 * |---|---|
 * | `node-pty` | its `package.json` has **no** `prebuildify` in the devDependencies → the `usesTool()` of electron-rebuild is false → the prebuildify probe never runs |
 * | `@serialport/bindings-cpp` | it has `prebuildify`, but it looks for `electron.napi.node` / `node.napi.node` / `electron.abi<N>.node`, while the real file is called `@serialport+bindings-cpp.node` → it is not found |
 *
 * (electron-rebuild **does** know the prebuildify layout, and the skip
 * criterion in `lib/module-rebuilder.js:140` has **no** `force` in it —
 * that is, `-f` is not the root cause. The two above are.)
 *
 * The price is **a whole toolchain**: node-gyp needs Python and MSVC, and
 * the `binding.gyp` of node-pty hardcodes `SpectreMitigation: 'Spectre'` —
 * without it the build fails with MSB8040 (**VS2022 does not ship the Spectre
 * libraries either**).
 *
 * So "a clean clone on a fresh Windows" only needed Node, and the postinstall
 * forced Python + Build Tools + 1.6 GB of Visual Studio on the machine.
 *
 * ── The criterion of this script ──
 *
 * **Is the native binary there, and does it load?**
 *
 * ⚠️ **Looking at nothing but whether `require('node-pty')` succeeds** is
 * not enough: on **the Windows branch node-pty does not touch the native
 * module at all when it is required** (the win32 branch of `lib/index.js`
 * only loads JavaScript, the native module is loaded lazily when
 * `spawn()` runs) — so **`require` succeeds even when there is not a single
 * native binary**, and using it as the criterion leads to the wrong
 * conclusion "everything loads → nothing has to be compiled".
 *
 * So this script **looks for the binary file directly** (the search order of
 * node-gyp-build: `build/Release` → `build/Debug` →
 * `prebuilds/<platform>-<arch>`), **and then really requires it once** — a
 * failure to load (the wrong architecture, a damaged file) is what counts.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** The native modules to check: the package directory + the name of the binary */
const MODULES = [
  { name: 'node-pty', dir: 'node_modules/node-pty', binary: 'pty.node' },
  {
    name: 'serialport',
    dir: 'node_modules/@serialport/bindings-cpp',
    binary: '@serialport+bindings-cpp.node',
  },
];

/**
 * Finds the native binary in the order of node-gyp-build.
 *
 * **It returns an absolute path** — `require` takes a relative path for a
 * module id and looks for it in node_modules, and reports "Cannot find
 * module 'node_modules/...'" (that looks like the file is gone, while it is
 * really the path that was not resolved).
 */
function findBinary(dir, binary) {
  const candidates = [
    join(dir, 'build', 'Release', binary),
    join(dir, 'build', 'Debug', binary),
    join(dir, 'prebuilds', `${process.platform}-${process.arch}`, binary),
  ];
  for (const p of candidates) if (existsSync(p)) return resolve(p);

  // When the name does not match, the next best thing: any .node in the directory of that platform
  const prebuildDir = join(dir, 'prebuilds', `${process.platform}-${process.arch}`);
  if (existsSync(prebuildDir)) {
    const any = readdirSync(prebuildDir).find((f) => f.endsWith('.node'));
    if (any) return resolve(join(prebuildDir, any));
  }
  return null;
}

/** The binary is there **and** loads → nothing is wrong */
function probe(mod) {
  const path = findBinary(mod.dir, mod.binary);
  if (!path) return { ok: false, why: `the native binary was not found (${mod.binary})` };
  try {
    require(path);
    return { ok: true, path };
  } catch (err) {
    const msg = String(err && err.message ? err.message : err).split('\n')[0];
    return { ok: false, why: `the native binary does not load: ${msg}`, path };
  }
}

const broken = [];
for (const mod of MODULES) {
  const r = probe(mod);
  if (r.ok) {
    console.log(`[native module] ${mod.name} ✓  ${r.path.replace(process.cwd(), '.')}`);
  } else {
    broken.push({ mod, why: r.why });
    console.log(`[native module] ${mod.name} ✗  ${r.why}`);
  }
}

if (broken.length === 0) {
  console.log('[native module] all of them work — no compiler is needed, the rebuild is skipped.');
  console.log('  (Both packages are NAPI, the prebuilds that ship with them work across the Node and the Electron versions.)');
  process.exit(0);
}

console.log('[native module] compiling from the source (this step needs Python + a C++ compiler) …');

const res = spawnSync(
  'npx',
  ['electron-rebuild', '-f', '-w', broken.map((b) => b.mod.name).join(',')],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);

if (res.status === 0) {
  const still = broken.filter((b) => !probe(b.mod).ok);
  if (still.length === 0) {
    console.log('[native module] the build is done, all of them work.');
    process.exit(0);
  }
  console.error(`[native module] the build is done but they still do not work: ${still.map((b) => b.mod.name).join(', ')}`);
  for (const b of still) console.error(`  ${b.mod.name}: ${probe(b.mod).why}`);
  process.exit(1);
}

console.error('[native module] the build failed.');
console.error('  Without a C++ compiler it cannot be installed — but the application still starts:');
console.error('  only the pty of the "host" channel does not work, the serial / ADB / SSH channels are not affected.');
console.error('  To install the compiler: on Windows install the "Desktop development with C++" workload of Visual Studio Build Tools.');
process.exit(0);

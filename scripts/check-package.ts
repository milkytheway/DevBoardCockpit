/**
 * **打包产物自检**（`npm run check:package`）。
 *
 * ── 它防的是哪类 bug ──
 *
 * 打包之后 `app.getAppPath()` = **asar 根** ✓（不是源码目录 ✓）。
 * → `cards/`（内置卡 ✓）、`profiles/`（连接 profile ✓ · 板型包 ✓ · 流程包 ✓）
 * **必须被 electron-builder 的 `files` 带进 asar** ✓，
 * 否则装好的应用**一张内置卡都没有** ✓ —— 而它在开发期完全看不出来：
 * `npm run build` 绿 ✓、测试全绿 ✓，**只有装上才炸** ✓。
 *
 * → 所以「打包配置对不对」**必须是一条能跑的判据** ✓，不是一段注释 ✓。
 *
 * ── 为什么自己读 asar 的头 ──
 *
 * → asar 的头是一段 JSON ✓（文件清单 ✓）→ 读它不需要额外依赖 ✓
 *   （`@electron/asar` 得先装上才能用 ✓ —— 而这个脚本要在**装之前**就能跑 ✓）。
 *
 * 用法：`npm run check:package`（`npm run dist` 之后 ✓）
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PRELOAD_FILE } from '../src/shared/build-layout';
import { FAKE_DEVICE_MARKER } from '../src/main/hal/fake/device';

interface Check {
  what: string;
  ok: boolean;
  detail: string;
}

/**
 * **asar 里的内置卡与 `cards/` 对不对得上** ✓（**纯函数** ✓ —— 好测 ✓）。
 *
 * → 判据 = **两边一模一样** ✓（**不是「至少有一张」** ✓ ——
 *   「≥1」**检不出陈旧的 asar** ✓：今天 10 张 · 旧 asar 6 张 → 照样「有卡」✓ ✗）。
 * → **比的是集合** ✓ —— 顺序无关 ✓。
 * → **期望为空 → 不过** ✓（「`cards/` 一张卡都没有」本身就是不对 ✓）。
 */
export function compareCards(
  expected: string[],
  inAsar: string[],
): { ok: boolean; missing: string[]; extra: string[] } {
  const missing = expected.filter((c) => !inAsar.includes(c));
  const extra = inAsar.filter((c) => !expected.includes(c));
  return { ok: expected.length > 0 && missing.length === 0 && extra.length === 0, missing, extra };
}

/**
 * **包里的代码是不是磁盘上那份**（**纯函数** ✓ —— 好测 ✓）。
 *
 * ── 为什么要有这条（**它是被真机事件打出来的** ✓）──
 *
 * → **2026-11-19**：用户把安装包装上了 ✓ → 我去看 ✓
 *   → **包里跑的是修复之前的代码** ⚠️
 *   （安装包 **00:55** ✓ · 那个修复 **21:38** 才提交 ✓ → **包比修复早 21 小时** ⚠️）。
 * → **后果**：装机版里「凡是能写板子的卡」**永久显示「降级」** ⚠️
 *   → 而**开发期与沙箱里全绿** ✓ → **只有装上才看得见** ✓。
 * → **`check:package` 原来验不出这个** ⚠️ → 它验「卡在不在」✓
 *   → **验不出「代码是不是最新的」** ⚠️ → **所以它成了漏网的** ⚠️。
 *
 * ── 判据怎么定 ──
 *
 * → **逐字节相等** ✓ —— 不比时间戳 ✓（**时间戳会被 `cp` 改** ✓ → 不可靠 ✓）。
 * → **任一边缺 → 不过** ✓ —— **不许「没有就跳过」** ✓（那样等于没这条判据 ✓）。
 */
export function compareBundle(
  inAsar: Buffer | undefined,
  onDisk: Buffer | undefined,
): { ok: boolean; detail: string } {
  if (inAsar === undefined) {
    return { ok: false, detail: 'asar 里没有 out/main/index.js —— 包没带 main 产物' };
  }
  if (onDisk === undefined) {
    return {
      ok: false,
      detail: '磁盘上没有 out/main/index.js —— 跑一次 `npm run build` 再验',
    };
  }
  if (!inAsar.equals(onDisk)) {
    return {
      ok: false,
      detail:
        `**包是陈旧的** ✓（asar 里 ${inAsar.length} 字节 · 磁盘上 ${onDisk.length} 字节 ✓）` +
        ' → **重打一次**（`npm run dist` ✓）→ **否则装上跑的是旧代码** ✓',
    };
  }
  return { ok: true, detail: `一致（${inAsar.length} 字节）` };
}

/** asar 的头：文件清单（路径 → {size, offset, ...} ✓） */
interface AsarHeader {
  files: Record<string, { size: number; offset: string; files?: Record<string, unknown> }>;
}

/**
 * 读 asar 的头。
 *
 * ── asar 的布局（头部）──
 *
 * ```
 * 0  : UInt32 = 4              （pickle 的载荷长度 ✓）
 * 4  : UInt32 = 头 pickle 的长度 ✓（文件内容从 8 + 它 开始 ✓）
 * 8  : UInt32 = 载荷长度 ✓
 * 12 : UInt32 = JSON 字符串的字节长度 ✓
 * 16 : JSON 字符串 ✓
 * ```
 */
function readAsarHeader(asarPath: string): AsarHeader {
  const buf = readFileSync(asarPath);
  const headerPickleSize = buf.readUInt32LE(4);
  const headerStringSize = buf.readUInt32LE(12);
  const json = buf.subarray(16, 16 + headerStringSize).toString('utf8');
  if (headerPickleSize <= 0) throw new Error(`asar 头长度不对：${headerPickleSize}`);
  return JSON.parse(json) as AsarHeader;
}

/** 把 asar 头里的嵌套清单摊平成「路径列表」✓ */
function flatten(header: AsarHeader, prefix = ''): string[] {
  const out: string[] = [];
  for (const [name, entry] of Object.entries(header.files)) {
    const path = prefix === '' ? name : `${prefix}/${name}`;
    out.push(path);
    if (entry.files !== undefined) {
      out.push(...flatten({ files: entry.files } as AsarHeader, path));
    }
  }
  return out;
}

/** 从 asar 里取一个文件的字节（按头里的 offset ✓） */
function readAsarFile(asarPath: string, header: AsarHeader, filePath: string): Buffer | undefined {
  const parts = filePath.split('/');
  let entry = header.files[parts[0] as string];
  for (const part of parts.slice(1)) {
    if (entry?.files === undefined) return undefined;
    entry = entry.files[part] as { size: number; offset: string };
  }
  if (entry === undefined || typeof entry.offset !== 'string') return undefined;
  // **头之后的字节才是文件内容** ✓（内容起点 = 8 + 头 pickle 长度 ✓）
  const buf = readFileSync(asarPath);
  const contentBase = 8 + buf.readUInt32LE(4);
  const start = contentBase + Number(entry.offset);
  return buf.subarray(start, start + entry.size);
}

function main(): void {
  const root = process.cwd();
  const releaseDir = join(root, 'release');
  const checks: Check[] = [];

  // ── 产物在吗 ────────────────────────────────────────────────────
  // **目录名带平台** ✓（`win-unpacked` / `linux-unpacked` / `mac-arm64-unpacked` ✓）
  // → 找**第一个** `*-unpacked` ✓（打包在哪个平台都能验 ✓）
  const unpackedDirs = existsSync(releaseDir)
    ? readdirSync(releaseDir)
        .filter((d) => d.endsWith('-unpacked'))
        .map((d) => join(releaseDir, d))
    : [];

  // **验哪个** —— **必须验「本次构建的那个」** ✓（2026-11-19 修 ✓）
  //
  // → 原来取的是 `unpackedDirs[0]` ✗ —— 那是 **`readdirSync` 的顺序** ✗
  //   （字母序 ✓ → **`linux-unpacked` 排在 `win-unpacked` 前面** ✓）
  // → 于是**在 Windows 上打包时，它验的是上一次在 Linux 沙箱里留下的旧包** ✗
  //   → 旧包 6 张卡 ✓ / 今天的 10 张 ✓ → 报「**少 4 张**」✗
  //   → 而**这次的 Windows 包里 10 张全在** ✓ → **自检把对的判成错的** ✗
  //   → **用户会被引到错的方向** ✗（去查 `files` 配置 ✓ —— 而它没问题 ✓）
  //
  // → **优先当前平台的** ✓ → 没有就取**最新修改的**那个 ✓（那才是最近构建的 ✓）
  const platformTag =
    process.platform === 'win32'
      ? 'win-'
      : process.platform === 'darwin'
        ? 'mac-'
        : 'linux-';
  const samePlatform = unpackedDirs.filter((d) => d.includes(platformTag));
  const unpackedDir =
    samePlatform[0] ??
    unpackedDirs
      .slice()
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ??
    join(releaseDir, 'win-unpacked');
  const asarPath = join(unpackedDir, 'resources', 'app.asar');
  const hasUnpacked = existsSync(unpackedDir);
  const hasAsar = existsSync(asarPath);
  checks.push({
    what: '打包产物存在（release/*-unpacked）',
    ok: hasUnpacked,
    detail: hasUnpacked ? unpackedDir : '还没有跑过 electron-builder',
  });
  checks.push({
    what: 'app.asar 存在',
    ok: hasAsar,
    detail: hasAsar ? asarPath : '找不到 app.asar',
  });

  if (!hasAsar) {
    console.error('✗ 打包产物自检不过：');
    for (const c of checks.filter((c) => !c.ok)) console.error(`  - ${c.what}\n      ${c.detail}`);
    console.error('\n  先跑 `npm run dist:dir`（不生成安装包，只出目录 ✓）再跑这个检查 ✓。');
    process.exit(1);
  }

  const header = readAsarHeader(asarPath);
  const paths = flatten(header);

  // ── 三段产物在 asar 里吗 ────────────────────────────────────────
  for (const needed of ['out/main/index.js', `out/preload/${PRELOAD_FILE}`, 'out/renderer/index.html']) {
    checks.push({
      what: `asar 里有 ${needed}`,
      ok: paths.includes(needed),
      detail: paths.includes(needed) ? '在' : '不在 —— `files` 少写了？',
    });
  }

  // ── **内置卡**在吗（打包后最常见的一条 ✓）────────────────────────
  //
  // → **判据是「asar 里的卡与 `cards/` 一模一样」✓**，**不是「至少有一张」** ✓
  //   —— 「≥1」**检不出陈旧的 asar** ✓（今天 10 张 · 旧 asar 6 张 → 照样「有卡」✓ ✗）。
  // → **期望值来自源码目录** ✓ —— **不写死数字** ✓（写死会随卡片增减而腐烂 ✓）。
  const cardManifests = paths.filter((p) => /^cards\/[^/]+\/manifest\.json$/.test(p));
  const inAsar = cardManifests.map((p) => p.split('/')[1]).sort();
  const sourceCardsDir = join(root, 'cards');
  const expectedCards = existsSync(sourceCardsDir)
    ? readdirSync(sourceCardsDir)
        .filter((d) => statSync(join(sourceCardsDir, d)).isDirectory())
        .filter((d) => existsSync(join(sourceCardsDir, d, 'manifest.json')))
        .sort()
    : [];
  const { ok: cardsOk, missing, extra } = compareCards(expectedCards, inAsar);
  checks.push({
    what: `asar 里的内置卡与 cards/ 一致（${expectedCards.length} 张）`,
    ok: cardsOk,
    detail:
      expectedCards.length === 0
        ? 'cards/ 目录里一张卡都没有 —— 这不对'
        : missing.length > 0 || extra.length > 0
          ? `对不上 ✓ —— **少 ${missing.length} 张**（${missing.join('、') || '无'}）` +
            ` · **多 ${extra.length} 张**（${extra.join('、') || '无'}）` +
            ` → **asar 是陈旧的？重打一次** ✓`
          : `${inAsar.length} 张全对：${inAsar.join('、')}`,
  });

  // ── **随应用分发的数据**在吗 ────────────────────────────────────
  for (const needed of [
    'profiles/settings.json',
    // **板型包的文件名是 `board.yaml`** ✓（不是 manifest.json ✓ —— 那是卡片用的 ✓）
    'profiles/boards/rk3588-atk/board.yaml',
  ]) {
    const present = paths.includes(needed);
    checks.push({
      what: `asar 里有 ${needed}`,
      ok: present,
      detail: present ? '在' : '不在 —— `files` 里少了 `profiles/**/*`',
    });
  }
  checks.push({
    what: 'asar 里有连接 profile（profiles/targets/*）',
    ok: paths.some((p) => p.startsWith('profiles/targets/')),
    detail: paths.filter((p) => p.startsWith('profiles/targets/')).slice(0, 5).join('、') || '没有',
  });
  checks.push({
    what: 'asar 里有流程包（profiles/workflows/*）',
    ok: paths.some((p) => p.startsWith('profiles/workflows/')),
    detail: paths.filter((p) => p.startsWith('profiles/workflows/')).slice(0, 5).join('、') || '没有',
  });

  // ── 生产包里不许有假设备（**合成数据不许进生产包** ✓）───────────
  const mainBundle = readAsarFile(asarPath, header, 'out/main/index.js');
  // ── **包里的代码是不是磁盘上那份**（2026-11-19 加 ✓）────────────
  //
  // → **它防的是「包比修复旧」** ✓（2026-11-19 真机事件 ✓）：
  //   装上以后才发现**包里跑的是修复之前的代码** ⚠️ → 而**开发期全绿** ✓。
  // → **`npm run dist` 先 `electron-vite build`** ✓ → **`out/` 是刚构建的** ✓
  //   → **两处不等 = 包是陈旧的** ✓。
  const diskBundlePath = join(root, 'out', 'main', 'index.js');
  const diskBundle = existsSync(diskBundlePath)
    ? readFileSync(diskBundlePath)
    : undefined;
  const bundleCmp = compareBundle(mainBundle, diskBundle);
  checks.push({
    what: '**包里的代码是最新的**（asar 的 out/main/index.js 与磁盘上的一致）',
    ok: bundleCmp.ok,
    detail: bundleCmp.ok
      ? bundleCmp.detail
      : `${bundleCmp.detail} —— **这一条抓的就是「装了旧代码」** ✓`,
  });
  const fakeInPackage = mainBundle?.toString('utf8').includes(FAKE_DEVICE_MARKER) ?? false;
  checks.push({
    what: '生产包里没有假设备',
    ok: !fakeInPackage,
    detail: fakeInPackage ? '假设备混进包里了 —— 用户会把假数当真数看' : '没有',
  });

  // ── 原生模块**解包**了吗（不解包 = 运行时找不到 .node ✓）────────
  const unpackedNative = join(unpackedDir, 'resources', 'app.asar.unpacked', 'node_modules');
  let nativeFound: string[] = [];
  if (existsSync(unpackedNative)) {
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full, `${prefix}${entry}/`);
          continue;
        }
        if (entry.endsWith('.node')) nativeFound.push(`${prefix}${entry}`);
      }
    };
    walk(unpackedNative, '');
  }
  checks.push({
    what: '原生模块已解包（.node 文件在 app.asar.unpacked 里）',
    ok: nativeFound.length > 0,
    detail:
      nativeFound.length > 0
        ? nativeFound.slice(0, 5).join('、')
        : '没找到 .node —— node-pty / serialport 在打包后可能加载不了',
  });

  // ── 汇总 ────────────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.error('✗ 打包产物自检不过：');
    for (const c of failed) console.error(`  - ${c.what}\n      ${c.detail}`);
    console.error('\n  三种常见原因：');
    console.error('  ① `files` 少写了 `cards/**/*` 或 `profiles/**/*`');
    console.error('     —— 打包后 `app.getAppPath()` = asar 根，少了就是「装上后一张卡都没有」。');
    console.error('  ② 生产构建里混进了假设备（合成数据不许进生产包）');
    console.error('  ③ **包比源码旧** ✓ —— 修完代码没重打 ✓ → **`npm run dist` 重打一次** ✓');
    console.error('     （**2026-11-19 真机踩过** ✓：装上以后才发现包里跑的是修复前的代码 ⚠️）');
    process.exit(1);
  }

  console.log(
    `✓ 打包产物自检通过（${cardManifests.length} 张内置卡 ✓ · 原生模块已解包 ✓ · 无假设备 ✓ · 包里的代码是最新的 ✓）`,
  );
}

// 直接运行时才执行 CLI；被 import 时只导出函数（`gen-vocabulary.ts` 同款规矩 ✓）
if (process.argv[1] && process.argv[1].endsWith('check-package.ts')) {
  main();
}

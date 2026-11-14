/**
 * 构建产物自检。
 *
 * **它防的是哪类 bug**：main 里写死了一个 preload 路径，
 * 而构建实际产出的是另一个文件名——**应用起来之后 `window.cockpit` 是 undefined，
 * 一个 API 都没有**，而且这个错误在开发期完全看不出来：
 * 构建成功、类型检查通过、测试全绿，只有真的把窗口打开才会暴露。
 *
 * 本工程已经踩过一次：main 指 `../preload/index.js`，
 * 而 electron-vite 因为 `package.json` 是 `"type": "module"` 产出了 `index.mjs`。
 *
 * 所以：**构建完必须验一次「main 要的那个文件真的在」。**
 * 这条检查跟 `npm run build` 绑在一起，跑不掉。
 *
 * 用法：npm run build（build 脚本末尾会自动调用）
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
 * 递归找出所有**含有某个标记**的文件（相对路径）。
 *
 * 目录不存在 → 空数组（不是错误：产物没建成是别处的检查负责）。
 */
function findFilesWithMarker(dir: string, marker: string): string[] {
  if (!existsSync(dir)) return [];
  const hits: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const relative = prefix === '' ? entry : `${prefix}/${entry}`;
      if (statSync(full).isDirectory()) {
        walk(full, relative);
        continue;
      }
      if (!/\.(js|cjs|mjs)$/.test(entry)) continue;
      if (readFileSync(full, 'utf8').includes(marker)) hits.push(relative);
    }
  };
  walk(dir, '');
  return hits;
}

function main(): void {
  const root = process.cwd();
  const outDir = join(root, 'out');
  const checks: Check[] = [];

  // ── 三段产物都在吗 ──────────────────────────────────────────────
  for (const seg of ['main', 'preload', 'renderer']) {
    const dir = join(outDir, seg);
    checks.push({
      what: `out/${seg} 存在`,
      ok: existsSync(dir),
      detail: dir,
    });
  }

  // ── preload 文件名 ──────────────────────────────────────────────
  const preloadDir = join(outDir, 'preload');
  const produced = existsSync(preloadDir)
    ? readdirSync(preloadDir).filter((f) => f.endsWith('.js') || f.endsWith('.cjs') || f.endsWith('.mjs'))
    : [];
  const preloadPath = join(preloadDir, PRELOAD_FILE);

  checks.push({
    what: `preload 产物是 ${PRELOAD_FILE}（main 要的就是它）`,
    ok: existsSync(preloadPath),
    detail: produced.length
      ? `构建产出的是：${produced.join(', ')}`
      : 'out/preload 里没有任何产物',
  });

  // ── preload 目录里**只有**那一个产物 ──────────────────────────────
  // 有了这一步，「陈旧产物骗过自检」就不可能：
  // 上一次构建留下的 index.mjs 会让这一条变红。
  const strays = produced.filter((f) => f !== PRELOAD_FILE);
  checks.push({
    what: `preload 目录里只有 ${PRELOAD_FILE}（没有陈旧产物）`,
    ok: strays.length === 0,
    detail: strays.length === 0 ? '干净' : `混进了：${strays.join(', ')}`,
  });

  // ── main 产物确实引用了它 ────────────────────────────────────────
  const mainBundle = join(outDir, 'main', 'index.js');
  if (existsSync(mainBundle)) {
    const src = readFileSync(mainBundle, 'utf8');
    checks.push({
      what: 'main 产物里引用的 preload 文件名是对的',
      ok: src.includes(PRELOAD_FILE),
      detail: src.includes(PRELOAD_FILE)
        ? `引用了 ${PRELOAD_FILE}`
        : `main 产物里找不到 ${PRELOAD_FILE}——代码与构建对不上`,
    });
  } else {
    checks.push({
      what: 'main 产物里引用的 preload 文件名是对的',
      ok: false,
      detail: 'out/main/index.js 不存在',
    });
  }

  // ── preload 产物真的是 CommonJS 吗 ────────────────────────────────
  // `.cjs` 后缀只保证「Node 按 CJS 解释它」；
  // 但如果构建把它产成了 ESM 语法（`import`），Electron 一样加载不了。
  // 所以看一眼内容：不能有顶层 `import`。
  if (existsSync(preloadPath)) {
    const preloadSrc = readFileSync(preloadPath, 'utf8');
    const looksEsm = /^\s*import\s[\s{*'"]/m.test(preloadSrc);
    checks.push({
      what: 'preload 产物是 CommonJS（沙箱 preload 跑不了 ESM）',
      ok: !looksEsm,
      detail: looksEsm
        ? '产物里有顶层 import —— 这是 ESM，沙箱 preload 加载不了'
        : '没有顶层 import，是 CommonJS',
    });
  }

  // ── renderer 的入口 HTML 在吗（loadFile 指着它）─────────────────
  const rendererHtml = join(outDir, 'renderer', 'index.html');
  checks.push({
    what: 'renderer 入口 HTML 存在',
    ok: existsSync(rendererHtml),
    detail: rendererHtml,
  });

  // ── 生产产物里不许有假设备 ────────────────────────────────────────
  //
  // **为什么这条非写不可**：假设备是**调试用的合成数据**——
  // 它要是混进了生产包，用户在面板上看到的就是编出来的数，
  // 而界面不会告诉他「这是假的」。
  //
  // 做法：生产构建把 `__COCKPIT_FAKE_BUILD__` 编成 `false`，
  // 动态 import 那个 chunk 就不该产出；这里**验它真的没产出**。
  // 标记串住在假设备自己的模块里（`hal/fake/device.ts`），
  // 那个模块**只可能**经由动态 import 进包 → 标记在 = 假设备在。
  const fakeHits = findFilesWithMarker(join(outDir, 'main'), FAKE_DEVICE_MARKER);
  checks.push({
    what: '生产产物里没有假设备（合成数据不许进生产包）',
    ok: fakeHits.length === 0,
    detail:
      fakeHits.length === 0
        ? `没找到标记「${FAKE_DEVICE_MARKER}」`
        : `标记「${FAKE_DEVICE_MARKER}」出现在：${fakeHits.join(', ')}`,
  });

  // ── 汇总 ────────────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.error('✗ 构建产物自检不过：');
    for (const c of failed) console.error(`  - ${c.what}\n      ${c.detail}`);
    console.error('\n  两种常见原因：');
    console.error('  ① main 里写死的 preload 路径与构建实际产出的文件名对不上');
    console.error('     —— 这类错误在开发期看不出来：窗口打开后 `window.cockpit` 是 undefined，整个应用没有 API。');
    console.error('  ② 调试用的东西（假设备）混进了生产包');
    console.error('     —— 生产包里出现合成数据，用户会把假数当真数看。');
    process.exit(1);
  }

  console.log(`✓ 构建产物自检通过（preload = ${PRELOAD_FILE}，沙箱 preload 必须是 CommonJS）`);
}

main();

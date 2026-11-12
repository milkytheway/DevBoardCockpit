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

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PRELOAD_FILE } from '../src/shared/build-layout';

interface Check {
  what: string;
  ok: boolean;
  detail: string;
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

  // ── 汇总 ────────────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.error('✗ 构建产物自检不过：');
    for (const c of failed) console.error(`  - ${c.what}\n      ${c.detail}`);
    console.error('\n  常见原因：main 里写死的 preload 路径与构建实际产出的文件名对不上。');
    console.error('  这类错误在开发期看不出来——窗口打开后 `window.cockpit` 是 undefined，整个应用没有 API。');
    process.exit(1);
  }

  console.log(`✓ 构建产物自检通过（preload = ${PRELOAD_FILE}，沙箱 preload 必须是 CommonJS）`);
}

main();

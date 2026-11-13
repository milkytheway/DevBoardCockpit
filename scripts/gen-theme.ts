/**
 * 主题 token 的生成器。
 *
 * `src/shared/theme/seed.ts` 是主题的**唯一权威**（手挑的那些值）。
 * 本脚本从它生成：
 *
 *   1. `src/renderer/theme/tokens.generated.css`（应用外壳用的 CSS 变量）
 *
 * **为什么要有它**：`tokens.css` 要是人手改的，就会出现**两份真相**
 * （种子一份、CSS 一份）——换皮改了种子，CSS 没跟上，
 * 于是「同一个 token 在两个地方是两个颜色」。
 * 有了这个脚本，`--check` 就能回答一个具体问题：
 * 「**生成的 CSS 与种子现在还一致吗？**」
 *
 * 用法：
 *   npx tsx scripts/gen-theme.ts          # 生成
 *   npx tsx scripts/gen-theme.ts --check  # 只检查，不一致就退出码 1
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { allThemesCss } from '../src/shared/theme/map';

const ROOT = resolve(process.cwd());
const OUT = join(ROOT, 'src', 'renderer', 'theme', 'tokens.generated.css');

function main(): void {
  const check = process.argv.includes('--check');
  const expected = allThemesCss();

  if (check) {
    if (!existsSync(OUT)) {
      console.error(`✗ 找不到生成产物：${OUT}`);
      console.error('  跑 npm run gen:theme 生成它。');
      process.exit(1);
    }
    const actual = readFileSync(OUT, 'utf8');
    if (actual !== expected) {
      console.error('✗ 主题 CSS 与种子不一致：');
      console.error(`  ${OUT} 与 src/shared/theme/seed.ts 对不上`);
      console.error('  跑 npm run gen:theme 重新生成。');
      process.exit(1);
    }
    console.log('✓ 主题 CSS 与种子一致');
    return;
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, expected, 'utf8');
  console.log(`已生成：${OUT}`);
}

// 直接运行时才执行 CLI；被 import 时只导出函数
if (process.argv[1] && process.argv[1].endsWith('gen-theme.ts')) {
  main();
}

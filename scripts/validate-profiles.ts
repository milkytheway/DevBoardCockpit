/**
 * 板型包校验命令（`npm run validate:profiles`）。
 *
 * **这个命令此前在文档里被引用了 30 处，而它一直不存在。**
 * 照抄文档的人会得到 `npm ERR! Missing script`——
 * 「契约说它该在，实现却没写」是最容易被忽略的一类欠账。
 *
 * 它做两件事：
 * 1. **加载**每个包（结构核对：未知字段报错）；
 * 2. **校验**每个包（契约 §七 的 27 条规则）。
 *
 * **有 error → 退出码 1。** warning 照打，但不影响退出码——
 * warning 是「你最好知道」的事，error 是「这个包不能用」的事。
 *
 * 用法：
 *   npm run validate:profiles
 *   npm run validate:profiles -- profiles/boards/rk3588-atk   # 只查一个包
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadBoardPack } from '../src/main/tags/pack';
import { validatePack, errorsOf, warningsOf } from '../src/main/tags/validator';
import type { ValidationIssue } from '../src/main/tags/validator';

// **用 `process.cwd()` 而不是 `__dirname`**：本工程是 `"type": "module"`，
// ESM 里没有 `__dirname`。仓库里的另两个脚本（gen-vocabulary / check-build）
// 也是这么做的——npm 跑脚本时 cwd 就是包根。
const REPO = process.cwd();
const BOARDS_DIR = join(REPO, 'profiles/boards');

/** 找到要校验的包目录 */
function packDirs(explicit: string[]): string[] {
  if (explicit.length > 0) {
    return explicit.map((p) => (p.startsWith('/') || /^[A-Za-z]:/.test(p) ? p : join(REPO, p)));
  }
  if (!existsSync(BOARDS_DIR)) return [];
  return readdirSync(BOARDS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(BOARDS_DIR, e.name))
    .filter((d) => existsSync(join(d, 'board.yaml')))
    .sort();
}

/** 一条问题怎么打印给人看 */
function format(issue: ValidationIssue): string {
  return `  规则 ${issue.rule} · ${issue.path}\n    ${issue.message}`;
}

function main(): number {
  const explicit = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const dirs = packDirs(explicit);

  if (dirs.length === 0) {
    console.error(`没有找到任何板型包（扫的是 ${BOARDS_DIR}）`);
    return 1;
  }

  let errorCount = 0;
  let warningCount = 0;

  for (const dir of dirs) {
    const name = dir.split(/[\\/]/).pop() ?? dir;
    console.log(`=== ${name} ===`);

    let pack;
    try {
      pack = loadBoardPack(dir);
    } catch (err) {
      // 加载失败 = 结构不对（规则 10 / 24 的未知字段那一半）
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ 加载失败：${message}`);
      errorCount += 1;
      continue;
    }

    const issues = validatePack(pack);
    const errs = errorsOf(issues);
    const warns = warningsOf(issues);

    for (const issue of warns) {
      console.log(format(issue));
    }
    for (const issue of errs) {
      console.error(format(issue));
    }

    errorCount += errs.length;
    warningCount += warns.length;

    if (errs.length === 0) {
      console.log(
        `  ✓ ${pack.readers.length} 个 reader、${pack.custom.length} 个私有 reader、` +
          `${pack.actions.length} 个动作、${pack.poll_groups.length} 个轮询组`,
      );
    }
    console.log('');
  }

  if (errorCount > 0) {
    console.error(`✗ ${dirs.length} 个包，${errorCount} 个错误，${warningCount} 个警告`);
    return 1;
  }
  console.log(`✅ ${dirs.length} 个包，0 个错误，${warningCount} 个警告`);
  return 0;
}

process.exit(main());

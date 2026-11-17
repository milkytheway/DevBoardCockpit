/**
 * 流程包的**账** —— 看有哪些。
 *
 * ── 为什么只有这一条命令 ──
 *
 * 「**放一个文件进目录 ≠ 它就能跑**」（`workflows/registry.ts` ✓）——
 * 那道闸**不在命令行** ✓，**在设置里的统一权限区** ✓（ADR-D47 ✓ · ADR-D48 ✓）：
 *
 * | 命令 | 干什么 |
 * |---|---|
 * | `npm run workflow:list` | 列注册表里的包 ✓（**id / 名字 / 版本** ✓） |
 *
 * → **「批过没有」那一列没了** ✓（2026-11-16 ✓ · ADR-D48 ✓）。
 */
import { WorkflowRegistry } from '../src/main/workflows/registry';
import { builtinWorkflowsDir, userWorkflowsDir } from '../src/main/util/paths';

function workflowDirs(): string[] {
  return [builtinWorkflowsDir(process.cwd()), userWorkflowsDir()];
}

function registry(): WorkflowRegistry {
  const reg = new WorkflowRegistry({
    dirs: workflowDirs(),
  });
  reg.scan();
  return reg;
}



const command = process.argv[2] ?? 'list';

switch (command) {
  case 'list': {
    const list = registry().list();
    if (list.length === 0) {
      console.log('还没有流程包。');
      console.log(`  放到 ${userWorkflowsDir()} 里（放进去 ≠ 能跑 ✓ —— 闸在设置里的权限区 ✓）。`);
      break;
    }
    console.log('流程包：');
    for (const w of list) {
      console.log(
        `  ${w.id}（${w.name} v${w.version}）`,
      );
    }
    break;
  }
  default:
    console.error(`不认识的命令：${command}（list）`);
    process.exit(2);
}

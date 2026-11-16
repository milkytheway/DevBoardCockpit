/**
 * 流程包的**账** —— 看有哪些、批过没有、点头。
 *
 * ── 为什么要有这一对命令 ──
 *
 * 「**放一个文件进目录 ≠ 批准它**」（`workflows/registry.ts` ✓）——
 * 那么「批准」这个动作**总得有人来做** ✓，而且**看得见** ✓：
 *
 * | 命令 | 干什么 |
 * |---|---|
 * | `npm run workflow:list` | 列注册表里的包 + **批过没有** ✓ |
 * | `npm run workflow:approve -- <id>` | **点头**（记进批准账 ✓，绑内容摘要 ✓） |
 * | `npm run workflow:revoke -- <id>` | 收回批准 ✓ |
 *
 * → 这一对命令是**人**用的 ✓（卡片与 agent 走 `WorkflowService` ✓，只认 id ✓）。
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
      console.log(`  放到 ${userWorkflowsDir()} 里（放进去 ≠ 批准 ✓）。`);
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

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
import { createInterface } from 'node:readline';
import { WorkflowRegistry, workflowApprovalsFile } from '../src/main/workflows/registry';
import {
  builtinWorkflowsDir,
  userDataDir,
  userWorkflowsDir,
} from '../src/main/util/paths';

function workflowDirs(): string[] {
  return [builtinWorkflowsDir(process.cwd()), userWorkflowsDir()];
}

function registry(): WorkflowRegistry {
  const reg = new WorkflowRegistry({
    dirs: workflowDirs(),
    approvalFile: workflowApprovalsFile(userDataDir()),
  });
  reg.scan();
  return reg;
}


/** 问人一句话，等他答（**人在终端上敲** ✓） */
function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

const command = process.argv[2] ?? 'list';
const id = process.argv[3];

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
        `  ${w.approved ? '✓ 已批准' : '○ 未批准'}  ${w.id}（${w.name} v${w.version}）` +
          `${w.approved ? '' : `  → npm run workflow:approve -- ${w.id}`}`,
      );
    }
    break;
  }
  case 'approve': {
    if (id === undefined) {
      console.error('缺流程 id（npm run workflow:approve -- <id>）');
      process.exit(2);
    }
    const reg = registry();
    // **先把这个包会干什么打出来**（评审 35 的 32-C1 ✓）：
    // 「点一下批准」之前，人得知道**会在哪些机器上跑哪些命令** ✓
    // —— 不然批准就只是「批准一个文件名」✓ → **等于没看** ✗。
    const plan = reg.planOf(id);
    if (plan === undefined) {
      console.error(`没有这个流程包：${id}`);
      process.exit(2);
    }
    console.log(`这个流程会做这些事：\n`);
    console.log(`  流程：${plan.name}（${plan.id}）\n`);
    console.log('  会在这些目标上跑：');
    for (const role of plan.roles) {
      console.log(`    ${role.role} → ${role.profile}（${role.purpose}）`);
    }
    console.log('\n  逐步：');
    for (const step of plan.steps) {
      const where = step.role === undefined ? '' : `@${step.role}`;
      const danger = step.dangerous ? '  ⚠ destructive（运行期还要再确认一次）' : '';
      const read = step.readbackRole === undefined ? '' : `（判据读在 ${step.readbackRole}）`;
      console.log(`    ${step.id}（${step.kind}）${where}${read}`);
      if (step.command !== undefined) console.log(`      $ ${step.command}`);
      if (danger !== '') console.log(`    ${danger.trim()}`);
    }
    console.log('\n  确认批准？（上面就是它会做的事）[y/N]');
    // **读一行**（人在终端上敲 ✓）
    const answer = (await ask('  ')).toLowerCase().trim();
    if (answer !== 'y' && answer !== 'yes') {
      console.log('没批准 ✓');
      break;
    }
    const approved = reg.approve(id);
    console.log(`\n已批准：${approved.id}（${approved.name}）`);
    console.log(`  摘要 ${approved.digest} —— **改了内容要重新批准** ✓`);
    break;
  }
  case 'revoke': {
    if (id === undefined) {
      console.error('缺流程 id（npm run workflow:revoke -- <id>）');
      process.exit(2);
    }
    registry().revoke(id);
    console.log(`已收回批准：${id}`);
    break;
  }
  default:
    console.error(`不认识的命令：${command}（list / approve / revoke）`);
    process.exit(2);
}

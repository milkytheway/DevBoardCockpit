/**
 * 宿主侧跑一条流程 —— **流程包首版的唯一入口**。
 *
 * > **为什么只有命令行**（ADR-D31 R1）：流程包首版是**宿主层格式**，
 * > 卡片 API 与 MCP 工具**首版不动契约** → 首版的触发方式就是**人在宿主上跑它** ✓
 * > （「卡片让用户选本机还是客机」那一条，是**后续的契约增量**——待裁决 D7。）
 *
 * ── 两条路，**权限不同** ──
 *
 * | 写法 | 走批准账吗 | 谁在用 |
 * |---|---|---|
 * | `--id <id>` | **要**（没批准跑不了 ✓） | 人与将来的卡片/agent ✓ |
 * | `--package <路径>` | **不走** | **开发/一次性**：人自己敲的路径 = 那一次点头 ✓ |
 *
 * → **卡片与 agent 只能走 `--id` 那条**（`WorkflowService` 只认 id ✓）。
 *
 * 用法：
 * ```powershell
 * npm run workflow:list                                   # 看有哪些、批过没有
 * npm run workflow:approve -- hello-kernel.build-run       # 点头（人做这一下）
 * npm run workflow:run -- --id hello-kernel.build-run --input project=01-hello
 * npm run workflow:run -- --package profiles/workflows/hello-kernel.build-run.yaml --input project=01-hello
 * ```
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { parseWorkflow, type WorkflowPack } from '../src/main/workflows/format';
import { TargetRegistry } from '../src/main/workflows/targets';
import { runWorkflow } from '../src/main/workflows/runner';
import { WorkflowRegistry, workflowApprovalsFile } from '../src/main/workflows/registry';
import { loadProfiles } from '../src/main/profiles/loader';
import { createConnection } from '../src/main/hal/registry';
import { ActionAudit } from '../src/main/actions/audit';
import { SessionLog } from '../src/main/logging/session-log';
import { builtinWorkflowsDir, userDataDir, userWorkflowsDir } from '../src/main/util/paths';

interface Args {
  package?: string;
  id?: string;
  input: Record<string, string>;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { input: {}, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--package' || arg === '-p') {
      out.package = argv[++i];
      continue;
    }
    if (arg === '--id') {
      out.id = argv[++i];
      continue;
    }
    if (arg === '--input' || arg === '-i') {
      const pair = argv[++i] ?? '';
      const at = pair.indexOf('=');
      if (at > 0) out.input[pair.slice(0, at)] = pair.slice(at + 1);
      continue;
    }
    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(
        [
          '用法：npm run workflow:run -- (--id <流程 id> | --package <流程包.yaml>) [--input 名字=值]...',
          '',
          '  --id        走**批准账**（没批准跑不了 ✓）—— 人与将来的卡片/agent 走这条',
          '  --package   直接跑一个文件（**开发/一次性**：人自己敲的路径 = 那一次点头 ✓）',
          '',
          '例子：',
          '  npm run workflow:run -- --id hello-kernel.build-run --input project=01-hello',
          '  npm run workflow:run -- --package profiles/workflows/hello-kernel.build-run.yaml --input project=01-hello',
          '',
          '配套：',
          '  npm run workflow:list                              看有哪些、批过没有',
          '  npm run workflow:approve -- <流程 id>              点头',
        ].join('\n'),
      );
      process.exit(0);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.package === undefined && args.id === undefined) {
    console.error('缺 --id 或 --package（要跑哪个流程包）');
    process.exit(2);
  }

  // ── 宿主里的连接 profile ──
  const dataDir = userDataDir();
  const profiles = loadProfiles({
    builtinDir: join(process.cwd(), 'profiles', 'targets'),
    userDir: join(dataDir, 'profiles', 'targets'),
  });
  const profileById = new Map(profiles.map((p) => [p.id, p]));

  // ── 流程包：两条路，权限不同 ──
  const pack = resolvePack(args);

  // ── 角色绑定的 profile 必须存在（**不许悄悄连到别的**）──
  for (const [name, role] of Object.entries(pack.roles)) {
    if (!profileById.has(role.profile)) {
      console.error(`角色「${name}」绑的 profile「${role.profile}」不存在`);
      process.exit(2);
    }
  }

  console.log(`流程：${pack.name}（${pack.id}）`);
  console.log(
    `角色：${Object.entries(pack.roles)
      .map(([n, r]) => `${n}→${r.profile}`)
      .join('，')}`,
  );

  if (args.dryRun) {
    console.log('\n--dry-run：不执行，只把步骤列出来：');
    for (const step of pack.steps) {
      console.log(`  ${step.id}（${step.kind}）${step.cmd ?? step.action ?? step.pattern ?? ''}`);
    }
    return;
  }

  const audit = new ActionAudit(join(dataDir, 'logs', 'actions.log'));
  const registry = new TargetRegistry({
    profileFor: (id) => profileById.get(id),
    createConnection: (profile) => {
      const log = new SessionLog({
        label: `workflow-${profile.id}`,
        transport: profile.transport,
        dataDir,
      });
      return createConnection(profile, log);
    },
  });

  try {
    const result = await runWorkflow(
      pack,
      args.input,
      {
        targets: registry,
        profileFor: (id) => profileById.get(id),
        audit: (row) => audit.append(row),
      },
      // **人跑它 = 这一次点头**（ADR-D31 R2 的信任模型 ✓）
      { approved: true },
    );

    console.log(`\n运行 ${result.runId}：${result.ok ? '成功' : '未成功'}`);
    for (const stage of result.stages) {
      const mark = stage.ok ? (stage.verified ? '✓' : '○') : '✗';
      console.log(
        `  ${mark} ${stage.stepId}（${stage.kind}）${stage.role ? `@${stage.role}` : ''}` +
          `${stage.reason ? ` — ${stage.reason}` : ''}${stage.detail ? `：${stage.detail}` : ''}` +
          `${stage.audit_id ? ` [${stage.audit_id}]` : ''}`,
      );
    }
    if (result.needsConfirmation !== undefined) {
      console.log(`\n⚠ 第 ${result.needsConfirmation.stepId} 步要人确认：${result.needsConfirmation.detail}`);
    }
    if (Object.keys(result.outputs).length > 0) {
      console.log(`\n产出：${JSON.stringify(result.outputs)}`);
    }
    process.exit(result.ok ? 0 : 1);
  } finally {
    await registry.closeAll();
  }
}

/**
 * 流程包：两条路，**权限不同** ✓。
 *
 * - `--id` → **注册表** → **必须已批准** ✓（卡片/agent 走的就是这条 ✓）；
 * - `--package` → 直接读那个文件（**人自己敲的路径 = 那一次点头** ✓ —— 开发/一次性用 ✓）。
 */
function resolvePack(args: Args): WorkflowPack {
  if (args.id !== undefined) {
    const registry = new WorkflowRegistry({
      dirs: workflowDirs(),
      approvalFile: workflowApprovalsFile(userDataDir()),
    });
    registry.scan();
    const found = registry.get(args.id);
    if (found === undefined) {
      console.error(`没有这个流程包：${args.id}`);
      process.exit(2);
    }
    if (!found.approved) {
      console.error(
        `流程包「${args.id}」还没有被批准。\n` +
          `  点头：npm run workflow:approve -- ${args.id}`,
      );
      process.exit(2);
    }
    return found.pack;
  }
  const path = resolve(process.cwd(), args.package as string);
  return parseWorkflow(yaml.load(readFileSync(path, 'utf8')), path);
}

/** 流程包目录：内置的 + 用户的（**同 id 时用户优先** ✓） */
function workflowDirs(): string[] {
  const dirs = [builtinWorkflowsDir(process.cwd()), userWorkflowsDir()];
  return dirs.filter((d) => existsSync(d));
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

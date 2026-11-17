/**
 * 宿主侧跑一条流程 —— **流程包首版的唯一入口**。
 *
 * > **为什么只有命令行**（ADR-D31 R1）：流程包首版是**宿主层格式**，
 * > 卡片 API 与 MCP 工具**首版不动契约** → 首版的触发方式就是**人在宿主上跑它** ✓
 * > （「卡片让用户选本机还是客机」那一条，是**后续的契约增量**——待裁决 D7。）
 *
 * ── 两条路，**取包的方式不同** ──
 *
 * | 写法 | 从哪儿取包 | 谁在用 |
 * |---|---|---|
 * | `--id <id>` | **注册表**（只认注册表里的 id ✓） | 人与将来的卡片/agent ✓ |
 * | `--package <路径>` | **一个文件**（路径就是那一次许可 ✓） | **开发/一次性** ✓ |
 *
 * → **卡片与 agent 只能走 `--id` 那条**（`WorkflowService` 只认 id ✓）。
 * → **两边都不再要「批准」** ✓（**2026-11-16 砍掉** ✓ · ADR-D48 ✓）——
 *   **能不能跑看设置里的统一权限区** ✓（`05` §7.2 ✓ · ADR-D47 ✓）。
 *
 * 用法：
 * ```powershell
 * npm run workflow:list                                   # 看有哪些
 * npm run workflow:run -- --id hello-kernel.build-run --input project=01-hello
 * npm run workflow:run -- --package profiles/workflows/hello-kernel.build-run.yaml --input project=01-hello
 * ```
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { parseWorkflow, type WorkflowPack } from '../src/main/workflows/format';
import { TargetRegistry } from '../src/main/workflows/targets';
import { runWorkflow, type WorkflowRunDeps } from '../src/main/workflows/runner';
import { WorkflowRegistry } from '../src/main/workflows/registry';
import { loadProfiles } from '../src/main/profiles/loader';
import { createConnection } from '../src/main/hal/registry';
import { loadBoardPack } from '../src/main/tags/pack';
import type { ActionDef } from '../src/main/tags/schema';
import { ActionAudit } from '../src/main/actions/audit';
import { SessionLog } from '../src/main/logging/session-log';
import { builtinWorkflowsDir, userDataDir, userWorkflowsDir } from '../src/main/util/paths';

interface Args {
  package?: string;
  id?: string;
  input: Record<string, string>;
  dryRun: boolean;
  /** 确认凭据（**人点头之后**带它重跑那一步 ✓） */
  /** 从第几步继续（续跑 ✓ —— 前面的步不重跑） */
  from?: number;
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
    if (arg === '--from') {
      out.from = Number(argv[++i]);
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(
        [
          '用法：npm run workflow:run -- (--id <流程 id> | --package <流程包.yaml>) [--input 名字=值]...',
          '',
          '  --id        走**注册表**（只认注册表里的 id ✓）—— 人与将来的卡片/agent 走这条',
          '  --package   直接跑一个文件（**开发/一次性**：人自己敲的路径 = 那一次许可 ✓）',
          '',
          '例子：',
          '  npm run workflow:run -- --id hello-kernel.build-run --input project=01-hello',
          '  npm run workflow:run -- --package profiles/workflows/hello-kernel.build-run.yaml --input project=01-hello',
          '',
          '配套：',
          '  npm run workflow:list                              看有哪些',
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

  // ── 板型包里的动作（`action` 步要用 ✓）──
  //
  // 之前 CLI **不给** `actionDef` ✗ → `action` 步在 CLI 里直接报
  // 「板型包里没有这个动作」✗ → **CLI 跑不了应用能跑的包** ✗（两份真相 ✓）。
  //
  // → 现在按角色绑的 profile 的 `board_pack` **静态加载那份包** ✓
  // （**应用里走运行时那条路** ✓ —— 那边按连接解析 ✓）。
  //
  // ⚠️ **回读形式 1（读 tag）在 CLI 里查不了** ✗ —— 流程层没有板型包的运行时 ✓
  // → `readTag` 返回 undefined ✓ → 那种动作在 CLI 里**回读不过** ✓（诚实 ✓）。
  const actionDefs = new Map<string, ActionDef>();
  for (const [roleName, role] of Object.entries(pack.roles)) {
    const profile = profileById.get(role.profile);
    const packId = profile?.board_pack;
    if (packId === undefined || packId === null || packId === '') continue;
    const dir = join(process.cwd(), 'profiles', 'boards', packId);
    if (!existsSync(dir)) continue;
    try {
      const loaded = loadBoardPack(dir);
      for (const def of loaded.actions) {
        // **同名不许有两个定义** ✗ → 先到先得 ✓（跨板时另说 ✓）
        if (!actionDefs.has(def.id)) actionDefs.set(def.id, def);
      }
    } catch (err) {
      console.error(`⚠ 角色「${roleName}」的板型包 ${packId} 读不了：${String(err)}`);
    }
  }

  const audit = new ActionAudit(join(dataDir, 'logs', 'actions.log'));
  // **确认凭据的库**（流程层与 M6 共用一份 ✓ —— 语义只有一处 ✓）
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
    const deps: WorkflowRunDeps = {
      targets: registry,
      profileFor: (id: string) => profileById.get(id),
      audit: (row) => audit.append(row),
      // **`action` 步要的动作定义** ✓（见上面那段注释 ✓）
      actionDef: (actionId: string) => actionDefs.get(actionId),
    };
    // **人跑它 = 这一次点头** ✓（ADR-D31 R2 的信任模型 ✓ —— **不再有要确认的步** ✓ · ADR-D48 ✓）
    const result = await runWorkflow(pack, args.input, deps, {
      ...(args.from === undefined ? {} : { startAt: args.from }),
    });

    console.log(`\n运行 ${result.runId}：${result.ok ? '成功' : '未成功'}`);
    for (const stage of result.stages) {
      const mark = stage.ok ? (stage.verified ? '✓' : '○') : '✗';
      console.log(
        `  ${mark} ${stage.stepId}（${stage.kind}）${stage.role ? `@${stage.role}` : ''}` +
          `${stage.reason ? ` — ${stage.reason}` : ''}${stage.detail ? `：${stage.detail}` : ''}` +
          `${stage.audit_id ? ` [${stage.audit_id}]` : ''}`,
      );
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
    });
    registry.scan();
    const found = registry.get(args.id);
    if (found === undefined) {
      console.error(`没有这个流程包：${args.id}`);
      process.exit(2);
    }
    // **不再查批准** ✓（ADR-D48 ✓ —— **存在即说明** ✓）
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

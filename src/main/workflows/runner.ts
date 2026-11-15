import { makeError } from '../../shared/errors';
import { invokeAction } from '../actions/executor';
import { runReadback, type ReadbackResult } from '../actions/readback';
import { encodeParams } from '../actions/encoder';
import { checkFloor } from '../actions/floor-check';
import type { AuditRow } from '../actions/audit';
import type { ActionDef, PackParam, ReadbackDef } from '../tags/schema';
import type { TagReading } from '../../shared/tag-reading';
import type { ConnectionProfile } from '../profiles/schema';
import type { Connection } from '../hal/connection';
import { capabilitiesFor } from '../hal/capabilities';
import type { TargetRegistry } from './targets';
import { discoverArtifacts } from './discover';
import { placementDir } from './placement';
import { substituteCommand, substituteValue, type RoleFacts, type SubstitutionContext } from './substitute';
import type { WorkflowPack, WorkflowStep, WorkflowStepKind } from './format';

/**
 * 流程的执行器 —— **把「一件事怎么做」跑出来**。
 *
 * ── 它不新造第二条执行路径 ──
 *
 * 每一个写步骤**都走 M6 的执行器**（`actions/executor.ts`）：
 * 编码 → 地板复查 → 授权 → （必要时）确认 → **执行 + 回读（一个独占事务）** → 审计。
 * → 流程层**只补两样东西**：
 * ① **指名目标**（`runTransaction` 接到哪个目标上 —— 计划 5 的 A17 缺口）；
 * ② **判据可以在别的角色上读**（跨目标的验证 —— ADR-D32 D32-2）。
 *
 * ── 自由命令（`exec`）怎么过授权 ──
 *
 * 契约 `spec/02` §5.6 的信任模型：**自由命令要人点头**。
 * → 流程被**启用**（人跑它）就是那一次点头 ✓；
 * → 所以自由命令在流程里是「已授权的」✓，
 * 但**命中危险地板 → 仍要单次确认**（地板的规矩不让步 ✓，RF-2 ✓）。
 *
 * ── 判据的读法 ──
 *
 * 判据**可以指名 role** → 「在板子上问板子」✓
 * （板型包的回读**只验「目标自己」**——跨目标的验证只有流程层能做 ✓）。
 */
export interface WorkflowStage {
  stepId: string;
  kind: WorkflowStepKind;
  /** 在哪个角色上跑的（回读步 = 在哪个角色上读的） */
  role?: string;
  ok: boolean;
  verified: boolean;
  reason?: string;
  detail?: string;
  /** 这一步的审计行 id（**追责单位**；时间线靠它指回审计） */
  audit_id?: string;
  /** 跨目标判据那一行的 id（**两个事实，两行账** ✓） */
  readback_audit_id?: string;
  at: number;
  durationMs: number;
  value?: unknown;
}

export interface WorkflowRunResult {
  runId: string;
  packId: string;
  ok: boolean;
  stages: WorkflowStage[];
  /** 产出的槽 */
  outputs: Record<string, string>;
  /** 有一步要人确认（自由命令命中了危险地板） */
  needsConfirmation?: { stepId: string; confirmId: string; detail: string };
}

export interface WorkflowRunDeps {
  /** 目标登记处（按 profile id 拿连接） */
  targets: TargetRegistry;
  /** 宿主里的连接 profile（角色事实从这里来） */
  profileFor: (profileId: string) => ConnectionProfile | undefined;
  /** 审计（每步一行）——**返回那一行的 id** */
  audit: (row: AuditRow) => string;
  /** 板型包里的动作（`action` 步用） */
  actionDef?: (actionId: string) => ActionDef | undefined;
  /** 读一个 tag（回读形式 1 用） */
  readTag?: (tag: string) => Promise<TagReading | undefined>;
  /** 确认凭据（自由命令命中地板时要人点头） */
  confirmations?: {
    issue(
      actionId: string,
      params: Record<string, unknown>,
      packId: string,
      contractVersion: string,
      now: number,
    ): string;
    /** **人点了确认** → 凭据才可用 ✓（契约 spec/04 §2.4.1 ✓） */
    approve(token: string, now: number): boolean;
    consume(
      token: string,
      actionId: string,
      params: Record<string, unknown>,
      packId: string,
      contractVersion: string,
      now: number,
    ): boolean;
  };
  /** 现在（毫秒） */
  now?: () => number;
}

export interface WorkflowRunOptions {
  /** **这次运行已经被人点头了**（宿主跑它 = 点头 ✓；ADR-D31 R2） */
  approved?: boolean;
  /** 每一步的确认凭据（step id → confirm_id） */
  confirmIds?: Record<string, string>;
  /**
   * **从第几步开始跑**（续跑时用 ✓）。
   *
   * → 为什么要它：destructive 步要人点头 → 流程**停在那一步** ✓ →
   * 人点了之后**从那一步继续** ✓ → **前面的步不能重跑** ✓
   * （重跑 = 编译两遍、传两遍 ✗）。
   */
  startAt?: number;
  /** 续跑时**带上之前的产出**（槽 ✓） */
  outputs?: Record<string, string>;
  /** **这次运行的 id**（续跑时沿用它 ✓ —— 续跑是**同一次运行** ✓） */
  runId?: string;
}

/** 跑的输入（按流程包声明的类型校验） */
export async function runWorkflow(
  pack: WorkflowPack,
  inputs: Record<string, unknown>,
  deps: WorkflowRunDeps,
  opts: WorkflowRunOptions = {},
): Promise<WorkflowRunResult> {
  const now = deps.now ?? (() => Date.now());
  const at = now();
  // **续跑是同一次运行** → runId 由调用方给 ✓（不给就现生成一个 ✓）
  const runId = opts.runId ?? `wf-${at.toString(36)}`;
  const outputs: Record<string, string> = {};
  const stages: WorkflowStage[] = [];
  let needsConfirmation: WorkflowRunResult['needsConfirmation'];

  // ── 输入：按包声明的类型校验（缺必填 / 类型不对 → **执行前**就拒）──
  let encodedInputs: Record<string, string>;
  try {
    encodedInputs = encodeParams(inputSchema(pack), inputs);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      runId,
      packId: pack.id,
      ok: false,
      stages: [
        {
          stepId: '(inputs)',
          kind: 'exec',
          ok: false,
          verified: false,
          reason: 'invalid_params',
          detail,
          at,
          durationMs: 0,
        },
      ],
      outputs,
    };
  }

  const roleFacts = factsOf(pack, deps);

  // **续跑**：从第几步开始 ✓ + 带上之前的产出 ✓
  const startAt = Math.max(0, opts.startAt ?? 0);
  if (opts.outputs !== undefined) {
    for (const [slot, value] of Object.entries(opts.outputs)) outputs[slot] = value;
  }

  for (const [index, step] of pack.steps.entries()) {
    if (index < startAt) continue;
    const stage = await runStep(step, {
      pack,
      runId,
      inputs,
      encodedInputs,
      roleFacts,
      outputs,
      deps,
      opts,
      now,
    });
    stages.push(stage);

    if (stage.reason === 'needs_confirmation') {
      needsConfirmation = {
        stepId: step.id,
        confirmId: String((stage.value as { confirmId?: string } | undefined)?.confirmId ?? ''),
        detail: stage.detail ?? '这一步要人确认',
      };
      break;
    }
    if (!stage.ok) {
      // `assert` 不符时可以不中断（`on_mismatch: continue`）
      if (step.kind === 'assert' && step.on_mismatch === 'continue') continue;
      break;
    }
  }

  return {
    runId,
    packId: pack.id,
    ok: stages.every((s) => s.ok) && needsConfirmation === undefined,
    stages,
    outputs,
    ...(needsConfirmation === undefined ? {} : { needsConfirmation }),
  };
}

/* ── 内部 ──────────────────────────────────────────────────────────── */

interface StepContext {
  pack: WorkflowPack;
  runId: string;
  inputs: Record<string, unknown>;
  encodedInputs: Record<string, string>;
  roleFacts: Record<string, RoleFacts>;
  outputs: Record<string, string>;
  deps: WorkflowRunDeps;
  opts: WorkflowRunOptions;
  now: () => number;
}

async function runStep(step: WorkflowStep, ctx: StepContext): Promise<WorkflowStage> {
  const at = ctx.now();
  const started = at;
  const role = step.role;

  // ── 端点（`file.transfer` 的源与目的地）──
  const endpoints = await resolveEndpoints(step, ctx);

  const substitution: SubstitutionContext = {
    inputs: ctx.inputs,
    encoded: ctx.encodedInputs,
    roleFacts: ctx.roleFacts,
    outputs: ctx.outputs,
    ...(endpoints === undefined ? {} : { endpoints }),
  };

  try {
    switch (step.kind) {
      case 'exec':
        return await runExec(step, ctx, substitution, role, started);
      case 'action':
        return await runAction(step, ctx, substitution, role, started);
      case 'discover':
        return await runDiscover(step, ctx, substitution, role, started);
      case 'file.transfer':
        return await runTransfer(step, ctx, substitution, endpoints, started);
      case 'await':
      case 'assert':
        return await runAssert(step, ctx, substitution, role, started);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const auditId = ctx.deps.audit({
      at: started,
      actor: `workflow:${ctx.pack.id}`,
      actionId: `workflow:${ctx.pack.id}:${step.id}`,
      params: {},
      ok: false,
      verified: false,
      detail,
    });
    return {
      stepId: step.id,
      kind: step.kind,
      ...(role === undefined ? {} : { role }),
      ok: false,
      verified: false,
      reason: 'failed',
      detail,
      audit_id: auditId,
      at: started,
      durationMs: ctx.now() - started,
    };
  }
}

/** 一个 `exec` 步：自由命令 → **过 M6 的执行器** */
async function runExec(
  step: WorkflowStep,
  ctx: StepContext,
  substitution: SubstitutionContext,
  role: string | undefined,
  started: number,
): Promise<WorkflowStage> {
  if (role === undefined || step.cmd === undefined) {
    throw makeError('IPC_INVALID_PAYLOAD', `exec 步 ${step.id} 缺 role 或 cmd`);
  }
  const command = substituteCommand(step.cmd, substitution);
  const profileId = ctx.pack.roles[role]?.profile;
  if (profileId === undefined) throw makeError('IPC_INVALID_PAYLOAD', `角色 ${role} 没绑定 profile`);

  // **合成一个动作定义** → 走 M6 的七步链（不新造第二条执行路径 ✓）
  const action: ActionDef = {
    id: `exec:${step.id}`,
    label: step.id,
    // **步可以声明自己是 destructive**（凭据准备那一步 ✓ A10）
    danger: step.danger ?? 'reversible',
    params: {},
    command,
    // **判据指名别的角色 → 执行器那边不验**（跨目标是另一个事务 ✓）
    readback:
      step.readback?.role !== undefined && step.readback.role !== role
        ? // **跨目标的判据不能塞 `none`**：`spec/02` §4.4.1 禁止 destructive 配 none ✓
          // → 执行器那边用 `command_ok`（这条命令自己的退出码 ✓），
          //   跨目标的那部分**由流程层另外验**（两个事实、两行账 ✓）
          { kind: 'command_ok' }
        : toReadbackDef(step.readback, substitution),
  };
  const outcome = await invokeAction(
    action,
    {},
    executorDeps(ctx, profileId, action.id, step.timeout_ms),
    {
      ...(ctx.opts.confirmIds?.[step.id] === undefined
        ? {}
        : { confirmId: ctx.opts.confirmIds[step.id] as string }),
    },
  );
  const cross = await crossRoleReadback(step, ctx, substitution, role, started);
  // **`out` 槽 = 这条命令的输出**（凭据准备那一步靠它把公钥交给下一步 ✓）
  if (step.out !== undefined && outcome.output !== undefined) {
    ctx.outputs[step.out] = outcome.output.trim();
  }
  return {
    stepId: step.id,
    kind: step.kind,
    role,
    ok: cross === undefined ? outcome.ok : cross.ok,
    verified: cross === undefined ? outcome.verified : cross.verified,
    ...(cross === undefined
      ? outcome.reason === undefined
        ? {}
        : { reason: outcome.reason }
      : cross.reason === undefined
        ? {}
        : { reason: cross.reason }),
    ...(cross === undefined
      ? outcome.detail === undefined
        ? {}
        : { detail: outcome.detail }
      : cross.detail === undefined
        ? {}
        : { detail: cross.detail }),
    ...(outcome.audit_id === undefined ? {} : { audit_id: outcome.audit_id }),
    ...(cross?.audit_id === undefined ? {} : { readback_audit_id: cross.audit_id }),
    at: started,
    durationMs: ctx.now() - started,
    ...(cross === undefined
      ? outcome.readback?.value === undefined
        ? {}
        : { value: outcome.readback.value }
      : cross.value === undefined
        ? {}
        : { value: cross.value }),
    ...(outcome.needsConfirmation === undefined
      ? {}
      : { value: { confirmId: outcome.needsConfirmation.confirmId } }),
  };
}

/**
 * 判据指名了**别的角色** → 由流程层在那个角色上跑。
 *
 * ── 为什么不能交给执行器 ──
 *
 * M6 的执行器**在执行的那条连接上回读**（SPEC-D22：执行与回读不可拆分 ✓）。
 * 跨目标的判据**在另一台机器上** → 那是**另一个事务** ✓
 * （本来就该分开：板子上没有产物，是板子的事实，不是客机那条命令的事实 ✓）。
 *
 * → 执行器那边给 `kind: none`（它不验）✓，流程层自己验 ✓，
 * **并且单独记一行审计**（两个事实，两行账 ✓）。
 */
async function crossRoleReadback(
  step: WorkflowStep,
  ctx: StepContext,
  substitution: SubstitutionContext,
  stepRole: string | undefined,
  started: number,
): Promise<
  | { ok: boolean; verified: boolean; reason?: string; detail?: string; value?: unknown; audit_id?: string }
  | undefined
> {
  const readRole = step.readback?.role;
  if (readRole === undefined || readRole === stepRole) return undefined;
  const result = await runReadbackOnRole(ctx, readRole, step.readback, substitution);
  const auditId = ctx.deps.audit({
    at: started,
    actor: `workflow:${ctx.pack.id}`,
    actionId: `workflow:${ctx.pack.id}:${step.id}:readback`,
    params: {},
    ok: result.ok,
    verified: result.verified,
    ...(result.value === undefined ? {} : { value: result.value }),
    ...(result.detail === undefined ? {} : { detail: result.detail }),
  });
  return {
    ok: result.ok,
    verified: result.verified,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(result.detail === undefined ? {} : { detail: result.detail }),
    ...(result.value === undefined ? {} : { value: result.value }),
    audit_id: auditId,
  };
}

/** 一个 `action` 步：引用板型包里**已声明的动作** → 走 M6 的执行器 */
async function runAction(
  step: WorkflowStep,
  ctx: StepContext,
  substitution: SubstitutionContext,
  role: string | undefined,
  started: number,
): Promise<WorkflowStage> {
  if (role === undefined || step.action === undefined) {
    throw makeError('IPC_INVALID_PAYLOAD', `action 步 ${step.id} 缺 role 或 action`);
  }
  const def = ctx.deps.actionDef?.(step.action);
  if (def === undefined) {
    throw makeError('IPC_INVALID_PAYLOAD', `板型包里没有这个动作：${step.action}`);
  }
  const profileId = ctx.pack.roles[role]?.profile;
  if (profileId === undefined) throw makeError('IPC_INVALID_PAYLOAD', `角色 ${role} 没绑定 profile`);

  // 参数：按动作自己的 schema 校验（**不信任包的自述** ✓）
  const values: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(step.params ?? {})) {
    values[key] = substituteValue(raw, substitution);
  }
  const outcome = await invokeAction(
    def,
    values,
    executorDeps(ctx, profileId, def.id, step.timeout_ms),
    {
      // **destructive 的动作步也要能确认**（两条评审都点了这一条 ✓）
      ...(ctx.opts.confirmIds?.[step.id] === undefined
        ? {}
        : { confirmId: ctx.opts.confirmIds[step.id] as string }),
    },
  );
  return {
    stepId: step.id,
    kind: step.kind,
    role,
    ok: outcome.ok,
    verified: outcome.verified,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
    ...(outcome.audit_id === undefined ? {} : { audit_id: outcome.audit_id }),
    at: started,
    durationMs: ctx.now() - started,
    ...(outcome.readback?.value === undefined ? {} : { value: outcome.readback.value }),
  };
}

/** 一个 `discover` 步：按规则找产物 → 落进槽 */
async function runDiscover(
  step: WorkflowStep,
  ctx: StepContext,
  substitution: SubstitutionContext,
  role: string | undefined,
  started: number,
): Promise<WorkflowStage> {
  if (role === undefined || step.pattern === undefined || step.out === undefined) {
    throw makeError('IPC_INVALID_PAYLOAD', `discover 步 ${step.id} 缺 role / pattern / out`);
  }
  const profileId = ctx.pack.roles[role]?.profile;
  if (profileId === undefined) throw makeError('IPC_INVALID_PAYLOAD', `角色 ${role} 没绑定 profile`);
  // **目录用值模式**（路径不该被引号包住——`list()` 拿的是路径，不是 shell 片段 ✓）
  const dir = substituteValue(step.dir ?? '.', substitution);
  // **规则也是值模式**（文件名与排除表都是名字，不是 shell 片段 ✓）
  const pattern = substituteValue(step.pattern as string, substitution);
  const exclude = (step.exclude ?? []).map((rule) => substituteValue(rule, substitution));
  const found = await ctx.deps.targets.runOn(profileId, async (conn) =>
    discoverArtifacts({ list: (d) => conn.list(d) }, {
      dir,
      pattern,
      ...(exclude.length === 0 ? {} : { exclude }),
    }),
  );
  if (found.length === 0) {
    const detail = `在 ${dir} 里没找到 ${pattern}`;
    const auditId = ctx.deps.audit({
      at: started,
      actor: `workflow:${ctx.pack.id}`,
      actionId: `workflow:${ctx.pack.id}:${step.id}`,
      params: {},
      ok: false,
      verified: false,
      detail,
    });
    return {
      stepId: step.id,
      kind: step.kind,
      role,
      ok: false,
      verified: false,
      reason: 'not_found',
      detail,
      audit_id: auditId,
      at: started,
      durationMs: ctx.now() - started,
    };
  }
  ctx.outputs[step.out] = found[0] as string;
  const auditId = ctx.deps.audit({
    at: started,
    actor: `workflow:${ctx.pack.id}`,
    actionId: `workflow:${ctx.pack.id}:${step.id}`,
    params: { dir, pattern },
    ok: true,
    verified: true,
    value: found.join(','),
    detail: `找到 ${found.length} 个`,
  });
  return {
    stepId: step.id,
    kind: step.kind,
    role,
    ok: true,
    verified: true,
    audit_id: auditId,
    at: started,
    durationMs: ctx.now() - started,
    value: found[0],
  };
}

/** 一个 `file.transfer` 步：搬运（命令在**源**目标上跑） */
async function runTransfer(
  step: WorkflowStep,
  ctx: StepContext,
  substitution: SubstitutionContext,
  endpoints: { from: string; to: string } | undefined,
  started: number,
): Promise<WorkflowStage> {
  if (endpoints === undefined || step.cmd === undefined) {
    throw makeError('IPC_INVALID_PAYLOAD', `file.transfer 步 ${step.id} 缺 from / to / cmd`);
  }
  const fromRole = step.from?.role as string;
  const profileId = ctx.pack.roles[fromRole]?.profile;
  if (profileId === undefined) throw makeError('IPC_INVALID_PAYLOAD', `角色 ${fromRole} 没绑定 profile`);

  const command = substituteCommand(step.cmd, substitution);
  const action: ActionDef = {
    id: `transfer:${step.id}`,
    label: step.id,
    danger: step.danger ?? 'reversible',
    params: {},
    command,
    // **判据指名别的角色 → 执行器那边不验**（跨目标是另一个事务 ✓）
    readback: step.readback?.role !== undefined && step.readback.role !== fromRole
      ? // 同上：**不用 `none`**（destructive 步禁止 none ✓）
        { kind: 'command_ok' }
      : toReadbackDef(step.readback, substitution),
  };
  const outcome = await invokeAction(
    action,
    {},
    executorDeps(ctx, profileId, action.id, step.timeout_ms),
    {
      ...(ctx.opts.confirmIds?.[step.id] === undefined
        ? {}
        : { confirmId: ctx.opts.confirmIds[step.id] as string }),
    },
  );
  const cross = await crossRoleReadback(step, ctx, substitution, fromRole, started);
  // 目的地路径进槽（后续步骤要用）
  if (outcome.ok && cross?.ok !== false && step.out !== undefined) ctx.outputs[step.out] = endpoints.to;
  return {
    stepId: step.id,
    kind: step.kind,
    role: fromRole,
    ok: cross === undefined ? outcome.ok : cross.ok,
    verified: cross === undefined ? outcome.verified : cross.verified,
    ...(cross === undefined
      ? outcome.reason === undefined
        ? {}
        : { reason: outcome.reason }
      : cross.reason === undefined
        ? {}
        : { reason: cross.reason }),
    ...(cross === undefined
      ? outcome.detail === undefined
        ? {}
        : { detail: outcome.detail }
      : cross.detail === undefined
        ? {}
        : { detail: cross.detail }),
    ...(outcome.audit_id === undefined ? {} : { audit_id: outcome.audit_id }),
    ...(cross?.audit_id === undefined ? {} : { readback_audit_id: cross.audit_id }),
    at: started,
    durationMs: ctx.now() - started,
    ...(cross === undefined
      ? outcome.readback?.value === undefined
        ? {}
        : { value: outcome.readback.value }
      : cross.value === undefined
        ? {}
        : { value: cross.value }),
  };
}

/**
 * 在**指名的角色**上跑一次判据。
 *
 * ── 为什么要有这个「跨目标」的入口 ──
 *
 * M6 的执行器**在执行的那条连接上回读**（SPEC-D22：执行与回读不可拆分 ✓）。
 * → 「客机跑完 scp 之后，**板子上**真的有那个文件了吗」**它验不了** ✗
 * （那是**另一台机器**的事——本来就不该在同一个事务里 ✓）。
 * → 跨目标的判据**由流程层跑** ✓（ADR-D32 D32-2）。
 */
async function runReadbackOnRole(
  ctx: StepContext,
  role: string,
  readback: WorkflowStep['readback'],
  substitution: SubstitutionContext,
): Promise<ReadbackResult> {
  const profileId = ctx.pack.roles[role]?.profile;
  if (profileId === undefined) throw makeError('IPC_INVALID_PAYLOAD', `角色 ${role} 没绑定 profile`);
  const profile = ctx.deps.profileFor(profileId);
  const hasExitCode = profile === undefined ? true : capabilitiesFor(profile).exitCode;

  return runReadback(
    toReadbackDef(readback, substitution),
    { raw: ctx.inputs, encoded: ctx.encodedInputs },
    {
      readTag: ctx.deps.readTag ?? (async () => undefined),
      readFile: async (path: string): Promise<string | null> => {
        const cat = await ctx.deps.targets.runOn(profileId, (conn) =>
          conn.exec(`cat -- ${quotePath(path)}`),
        );
        return cat.timedOut || cat.exitCode !== 0 ? null : cat.stdout;
      },
      // **跨目标的判据命令也要过危险地板**（它跑在**另一台机器**上 ✓ ——
      // 两条评审都点了这一条 ✓）→ 命中就**不执行**，判据失败 ✓。
      exec: (command: string) => {
        const floor = checkFloor(command);
        if (floor.verdict === 'destructive') {
          throw makeError(
            'PACK_INVALID',
            `跨目标判据的命令命中危险地板（${floor.why ?? '危险命令'}），不执行`,
            { detail: { command, pattern: floor.pattern } },
          );
        }
        return ctx.deps.targets.runOn(profileId, (conn) => conn.exec(command));
      },
      hasExitCode,
    },
  );
}

/** 一个 `await` / `assert` 步：只跑判据（**可以指名在哪个角色上读**） */
async function runAssert(
  step: WorkflowStep,
  ctx: StepContext,
  substitution: SubstitutionContext,
  role: string | undefined,
  started: number,
): Promise<WorkflowStage> {
  const readRole = step.readback?.role ?? role;
  if (readRole === undefined) {
    throw makeError('IPC_INVALID_PAYLOAD', `${step.kind} 步 ${step.id} 没说在哪个角色上读`);
  }
  const result = await runReadbackOnRole(ctx, readRole, step.readback, substitution);

  const auditId = ctx.deps.audit({
    at: started,
    actor: `workflow:${ctx.pack.id}`,
    actionId: `workflow:${ctx.pack.id}:${step.id}`,
    params: {},
    ok: result.ok,
    verified: result.verified,
    ...(result.value === undefined ? {} : { value: result.value }),
    ...(result.detail === undefined ? {} : { detail: result.detail }),
  });
  return {
    stepId: step.id,
    kind: step.kind,
    role: readRole,
    ok: result.ok,
    verified: result.verified,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(result.detail === undefined ? {} : { detail: result.detail }),
    audit_id: auditId,
    at: started,
    durationMs: ctx.now() - started,
    ...(result.value === undefined ? {} : { value: result.value }),
  };
}

/* ── 工具 ──────────────────────────────────────────────────────────── */

/** 流程包的 inputs → 编码器的 schema（`path` 当 `string` ✓——编码规则一样） */
function inputSchema(pack: WorkflowPack): Record<string, PackParam> {
  const schema: Record<string, PackParam> = {};
  for (const [name, def] of Object.entries(pack.inputs)) {
    schema[name] = {
      type: def.type === 'path' ? 'string' : def.type,
      ...(def.maxLength === undefined ? {} : { maxLength: def.maxLength }),
      ...(def.min === undefined ? {} : { min: def.min }),
      ...(def.max === undefined ? {} : { max: def.max }),
      ...(def.values === undefined ? {} : { values: def.values }),
    } as PackParam;
  }
  return schema;
}

/** 角色的连接事实（**封闭**：host / port / user / key / profile_id） */
function factsOf(pack: WorkflowPack, deps: WorkflowRunDeps): Record<string, RoleFacts> {
  const facts: Record<string, RoleFacts> = {};
  for (const [name, role] of Object.entries(pack.roles)) {
    const profile = deps.profileFor(role.profile);
    if (profile === undefined) continue;
    const options = profile.options as Record<string, unknown>;
    facts[name] = {
      host: typeof options['host'] === 'string' ? (options['host'] as string) : '',
      port: typeof options['port'] === 'number' ? (options['port'] as number) : 22,
      user: typeof options['username'] === 'string' ? (options['username'] as string) : 'root',
      ...(typeof options['key_filename'] === 'string'
        ? { key: options['key_filename'] as string }
        : {}),
      profile_id: profile.id,
    };
  }
  return facts;
}

/** 端点（源路径与目的地路径）——`placement` 要问目标机器的内核版本 */
async function resolveEndpoints(
  step: WorkflowStep,
  ctx: StepContext,
): Promise<{ from: string; to: string } | undefined> {
  if (step.kind !== 'file.transfer') return undefined;
  const substitution: SubstitutionContext = {
    inputs: ctx.inputs,
    encoded: ctx.encodedInputs,
    roleFacts: ctx.roleFacts,
    outputs: ctx.outputs,
  };
  const from = step.from?.path === undefined ? undefined : substituteValue(step.from.path, substitution);
  if (from === undefined) throw makeError('IPC_INVALID_PAYLOAD', `file.transfer 步 ${step.id} 缺 from.path`);

  let to: string | undefined;
  if (step.to?.path !== undefined) {
    to = substituteValue(step.to.path, substitution);
  } else if (step.to?.placement !== undefined) {
    const roleName = step.to.role;
    const profileId = ctx.pack.roles[roleName]?.profile;
    if (profileId === undefined) throw makeError('IPC_INVALID_PAYLOAD', `角色 ${roleName} 没绑定 profile`);
    // **落位目录要问目标机器**（内核模块的路径里有版本号 ✓）
    const release = await ctx.deps.targets.runOn(profileId, async (conn) => {
      const result = await conn.exec('uname -r');
      return result.timedOut || result.exitCode !== 0 ? '' : result.stdout.trim();
    });
    const dir = placementDir(step.to.placement as 'kernel-module', { kernel_release: release });
    to = `${dir}${basenameOf(from)}`;
  }
  if (to === undefined) throw makeError('IPC_INVALID_PAYLOAD', `file.transfer 步 ${step.id} 缺目的地`);
  return { from, to };
}

/** 路径的文件名 */
function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** 流程包的判据 → M6 的判据（**五种形式一模一样** ✓） */
function toReadbackDef(
  readback: WorkflowStep['readback'],
  substitution: SubstitutionContext,
): ReadbackDef {
  if (readback === undefined) {
    return { kind: 'none', consequence: '这个步骤没有声明判据' };
  }
  const def: Record<string, unknown> = {};
  if (readback.tag !== undefined) {
    def['tag'] = substituteValue(readback.tag, substitution);
    if (readback.expect !== undefined) def['expect'] = substituteValue(readback.expect, substitution);
    return def as unknown as ReadbackDef;
  }
  if (readback.kind !== undefined) def['kind'] = readback.kind;
  if (readback.expect !== undefined) def['expect'] = substituteValue(readback.expect, substitution);
  if (readback.path !== undefined) def['path'] = substituteValue(readback.path, substitution);
  if (readback.tolerance !== undefined) def['tolerance'] = readback.tolerance;
  if (readback.command !== undefined) {
    def['command'] = substituteCommand(readback.command, substitution);
  }
  if (readback.timeout_ms !== undefined) def['timeout_ms'] = readback.timeout_ms;
  if (readback.consequence !== undefined) def['consequence'] = readback.consequence;
  return def as unknown as ReadbackDef;
}

/**
 * 确认凭据：**必须绑住这一步的输入** ✓。
 *
 * ── 为什么不能只绑动作参数 ──
 *
 * 执行器的确认凭据绑的是 `(动作 id, 参数摘要, 板型包 id, 契约版本)`。
 * 流程的自由命令**没有动作参数** → 摘要恒为空 →
 * **同一张凭据换一组 inputs 就能复用** ✗（两条评审都点了这一条 ✓）。
 * → 把**这一步的输入**并进摘要里 ✓ → 换输入 = 换摘要 = 凭据作废 ✓。
 */
function confirmationsFor(ctx: StepContext): NonNullable<WorkflowRunDeps['confirmations']> {
  const store = ctx.deps.confirmations;
  if (store === undefined) {
    return { issue: () => '', consume: () => false, approve: () => false };
  }
  const bind = (params: Record<string, unknown>): Record<string, unknown> => ({
    ...params,
    // **输入进摘要**（键名加前缀，免得跟动作参数重名 ✓）
    ...Object.fromEntries(Object.entries(ctx.inputs).map(([k, v]) => [`input:${k}`, v])),
  });
  return {
    issue: (actionId, params, packId, contractVersion, now) =>
      store.issue(actionId, bind(params), packId, contractVersion, now),
    // **批准不绑参数**（它是「人点了」那一下 ✓ —— 摘要管的是「这一次执行」✓）
    approve: (token, now) => store.approve(token, now),
    consume: (token, actionId, params, packId, contractVersion, now) =>
      store.consume(token, actionId, bind(params), packId, contractVersion, now),
  };
}

/** 执行器需要的依赖（**接到指名目标上** ✓ —— 计划 5 的 A17） */
function executorDeps(ctx: StepContext, profileId: string, actionId: string, timeoutMs?: number) {
  const profile = ctx.deps.profileFor(profileId);
  return {
    packId: ctx.pack.id,
    contractVersion: 'devboard/v1',
    hasExitCode: profile === undefined ? true : capabilitiesFor(profile).exitCode,
    // **执行与回读在同一条目标上、同一个独占事务里**（SPEC-D22 ✓）
    runTransaction: <T>(fn: (connection: Connection) => Promise<T>): Promise<T> =>
      ctx.deps.targets.runOn(profileId, (connection) => fn(connection)),
    readTag: ctx.deps.readTag ?? (async () => undefined),
    granted: () => ({
      actions: {
        // **这次运行被人启用了 → 这个动作算已授权**（ADR-D31 R2 的信任模型 ✓）
        // ——但**命中危险地板仍要单次确认**（地板的规矩不让步 ✓）
        [actionId]: undefined,
      },
    }),
    confirmations: confirmationsFor(ctx),
    audit: (row: AuditRow) =>
      ctx.deps.audit({ ...row, actor: row.actor === 'unknown' ? `workflow:${ctx.pack.id}` : row.actor }),
    actor: `workflow:${ctx.pack.id}`,
    now: ctx.now,
    // **长步骤要有超时**（编译是分钟级；尖兵实测传输波动 20 倍，A14 ✓）
    ...(timeoutMs === undefined ? {} : { execTimeoutMs: timeoutMs }),
  };
}

/** 路径的引号（与 HAL 同一份 ✓） */
function quotePath(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

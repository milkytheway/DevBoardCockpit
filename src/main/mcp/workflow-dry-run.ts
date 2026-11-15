import { substituteCommand } from '../workflows/substitute';
import type { WorkflowPack, WorkflowStep } from '../workflows/format';

/**
 * **流程的 dry_run**（契约 `spec/04` §2.4 的 `run_workflow(id, inputs, dry_run)` ✓）。
 *
 * ── 为什么要有 ──
 *
 * **流程会改别人的机器** ✓（编译 ✓ · 写 `authorized_keys` ✓ · 装模块 ✓ · 重启 ✓）
 * → agent 在跑之前**应该能看见它要干什么** ✓。
 *
 * ── 三条底线 ──
 *
 * | # | 底线 | 为什么 |
 * |---|---|---|
 * | 1 | **不执行任何一步** ✓ | 它是**预览** ✓ |
 * | 2 | **不写审计** ✓ | 审计记的是「每一次尝试」✓ —— 预览**连尝试都不是** ✓ |
 * | 3 | **不产生 `run_id`** ✓ | 没有运行 → 没有运行 id ✓ |
 *
 * ── 「不猜」的边界 ──
 *
 * → **角色事实（`{role:x.host}`）留成占位** ✓ —— **dry_run 时没有连接** ✓
 *   （**建连接就是「做」了** ✓ —— 哪怕只是握手 ✓）→ **不填假值** ✓。
 * → **输出槽（`{output:...}`）也留占位** ✓ —— **它要跑起来才有** ✓。
 * → **输入值是真的** ✓ —— 那**agent 自己给的** ✓。
 */
export interface DryRunStep {
  /** 步骤 id */
  id: string;
  /** 步骤类型 */
  kind: string;
  /** 执行角色（**没有就是没有** ✓ —— 不猜 ✓） */
  role?: string;
  /** **将要执行的命令**（**替换了输入值** ✓ · **没跑的命令** ✓） */
  command?: string;
  /** 引用的动作 id（`action` 步 ✓） */
  action?: string;
  /** 这一步的判据（**回读读什么** ✓） */
  readback?: { kind: string; tag?: string; path?: string };
  /** 危险等级（**默认 `reversible`** ✓） */
  danger: 'reversible' | 'destructive';
  /** 超时（毫秒） */
  timeout_ms?: number;
}

export interface DryRunResult {
  ok: boolean;
  /** 将要跑的步骤（**没跑** ✓） */
  steps?: DryRunStep[];
  /** 没有运行 → 没有运行 id ✓ */
  run_id?: undefined;
  reason?: 'invalid_params' | 'not_found';
  detail?: string;
}

/**
 * **预览一条流程** ✓。
 *
 * @param pack 流程包
 * @param inputs 输入值（**agent 自己给的** ✓）
 */
export function dryRunWorkflow(
  pack: WorkflowPack,
  inputs: Record<string, unknown>,
): DryRunResult {
  // ── 必填输入齐吗 ──
  for (const [name, spec] of Object.entries(pack.inputs)) {
    const value = inputs[name];
    if (value === undefined && spec.default === undefined) {
      return {
        ok: false,
        reason: 'invalid_params',
        detail: `缺输入：${name}`,
      };
    }
  }

  // ── 角色绑的 profile **不在这里判** ✓ ──
  //
  // → **dry_run 不连任何机器** ✓（**建连接就是「做」了** ✓ —— 哪怕只是握手 ✓）
  // → 所以**「这个 profile 存不存在」这件事，dry_run 答不了** ✓
  //   → **不猜** ✓ → **不报一个自己验不了的错** ✓。
  // → **真的跑之前**（`run_workflow` 不带 dry_run ✓）**流程层会查** ✓（`requireApproved` ✓ + 目标登记处 ✓）。

  // ── 输入按类型编码（命令模式用**编码片段** ✓ —— 同 runner ✓）──
  const encoded: Record<string, string> = {};
  for (const [name, spec] of Object.entries(pack.inputs)) {
    const raw = inputs[name] ?? spec.default;
    if (raw === undefined) continue;
    encoded[name] = encodeInput(spec.type, raw);
  }

  // ── 逐步预览 ──
  const steps: DryRunStep[] = pack.steps.map((step) => previewStep(step, inputs, encoded));

  return { ok: true, steps };
}

/** 一步的预览 ✓ */
function previewStep(
  step: WorkflowStep,
  inputs: Record<string, unknown>,
  encoded: Record<string, string>,
): DryRunStep {
  const out: DryRunStep = {
    id: step.id,
    kind: step.kind,
    // **危险等级默认 `reversible`** ✓（契约 §5.2 那一档 ✓）
    danger: step.danger ?? 'reversible',
  };
  if (step.role !== undefined) out.role = step.role;
  if (step.timeout_ms !== undefined) out.timeout_ms = step.timeout_ms;
  if (step.action !== undefined) out.action = step.action;

  if (step.cmd !== undefined) {
    // **只替换输入** ✓ —— **角色事实与输出槽留占位** ✓（**没连接、没跑** ✓ → 不知道 ✓）
    out.command = substituteCommand(step.cmd, {
      inputs,
      encoded,
      roleFacts: {},
      outputs: {},
    });
  }

  if (step.readback !== undefined) {
    const rb: { kind: string; tag?: string; path?: string } = { kind: step.readback.kind };
    if (step.readback.tag !== undefined) rb.tag = step.readback.tag;
    if (step.readback.path !== undefined) rb.path = step.readback.path;
    out.readback = rb;
  }

  return out;
}

/**
 * **输入值按类型编码** ✓（命令模式要**编码片段** ✓ —— 同 `encoder` 的规矩 ✓）。
 *
 * → **只用三种类型** ✓（流程包的输入声明只有那三种 ✓ —— `string` / `integer` / `number` ✓）。
 */
function encodeInput(type: string, raw: unknown): string {
  if (type === 'integer' || type === 'number') {
    return String(raw);
  }
  // **字符串按 shell 片段包引号** ✓（同 `actions/encoder` 的 `quoteShellValue` ✓）
  return `'${String(raw).replace(/'/g, "'\\''")}'`;
}

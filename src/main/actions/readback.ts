import type { ExecResult } from '../hal/connection';
import type { TagReading } from '../../shared/tag-reading';
import type { ReadbackDef } from '../tags/schema';
import { PLACEHOLDER } from '../util/shell-quote';

/**
 * 回读 —— 契约 `docs/spec/02-board-pack.md` §4.4「回读的五种形式」。
 *
 * ── 为什么回读是强制的 ──
 *
 * 契约 §5.2：「**回读是强制的**。运行时在动作执行后按 `readback` 取值，
 * 把这个值作为动作结果返回。卡片**必须**用返回值渲染，不能自己乐观更新。」
 *
 * → **没回读 = 不知道板子有没有真的进入目标状态**，
 * 而驾驶舱显示「已生效」其实没生效，是这个产品最不能出的错。
 *
 * ── 五种形式 ──
 *
 * | 形式 | 看什么 |
 * |---|---|
 * | 1 `tag`（**默认**） | 定向读一次那个 tag（**新鲜的**，不是等下一个周期） |
 * | 2 `file_equals` | 读文件比值（`expect` 可以是 `{param}`，有 `tolerance`） |
 * | 3 `command_ok` | **动作自己那条命令**的退出码（**不跑第二条命令**） |
 * | 4 `verify` | 再跑一条二次验证命令，轮询到成功或超时 |
 * | 5 `none` | 没有可观测状态 → **`ok: true` + `verified: false`** |
 *
 * ── 串口上没有退出码（事实 S5）──
 *
 * 形式 3 与 4 都看退出码 → **在串口传输上必须被拒绝**
 * （契约 §4.4 末尾：「在串口传输上必须拒绝这两种形式」）。
 */

/** 回读的结果 */
export interface ReadbackResult {
  /** 动作执行成功了吗（命令跑完了没有） */
  ok: boolean;
  /** **确认**板子真的进入目标状态了吗 */
  verified: boolean;
  /** 回读到的值 */
  value?: number | string | boolean | null;
  unit?: string;
  /** 回读到的那个 tag 的状态 */
  status?: TagReading['status'];
  /** 为什么不符 / 为什么不成立 */
  reason?:
    | 'readback_mismatch'
    | 'not_found'
    | 'timeout'
    | 'unsupported_transport'
    | 'failed'
    /** **被叫停了** ✓（不是「不符」✓ —— 人叫停 ≠ 板子不听话 ✓） */
    | 'cancelled';
  /** 期望值 */
  expected?: unknown;
  /** 实际值 */
  actual?: unknown;
  /** 给人看的一句话 */
  detail?: string;
}

/** 参数（两副面孔） */
export interface ReadbackParams {
  /** **原始值**——比较用（`expect` 是值，不是 shell 片段） */
  raw: Record<string, unknown>;
  /** **编码后的片段**——拼命令用（`'x'` 这种） */
  encoded: Record<string, string>;
}

/** 回读需要的能力（都是「能做什么」，不是「怎么连」） */
export interface ReadbackDeps {
  /** 读一个 tag（**新鲜的**） */
  readTag: (tag: string) => Promise<TagReading | undefined>;
  /** 读一个文件（远端）；读不到回 `null` */
  readFile: (path: string) => Promise<string | null>;
  /** 跑一条命令 */
  exec: (command: string) => Promise<ExecResult>;
  /** **这条连接有退出码吗**（串口没有，事实 S5） */
  hasExitCode: boolean;
  /** 等一会儿（`verify` 轮询用） */
  sleep?: (ms: number) => Promise<void>;
}

/** 把 `{param}` 换成给定的值 */
function substitute(text: string, values: Record<string, unknown>): string {
  return text.replace(PLACEHOLDER, (_match, name: string) => {
    const value = values[name];
    return value === undefined ? `{${name}}` : String(value);
  });
}

/** 两个值算不算一样（数字按数字比，其余按字面量比） */
function sameValue(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (actual === null || actual === undefined) return false;
  const a = typeof actual === 'number' ? actual : Number(actual);
  const b = typeof expected === 'number' ? expected : Number(expected);
  if (Number.isFinite(a) && Number.isFinite(b) && typeof actual !== 'string') return a === b;
  return String(actual) === String(expected);
}

/** 形式 1：读一个 tag */
async function readTagForm(
  spec: ReadbackDef,
  params: ReadbackParams,
  deps: ReadbackDeps,
): Promise<ReadbackResult> {
  const tag = spec.tag;
  if (typeof tag !== 'string' || tag.length === 0) {
    return { ok: false, verified: false, reason: 'failed', detail: '回读没有说读哪个 tag' };
  }
  const reading = await deps.readTag(tag);
  if (reading === undefined) {
    return { ok: false, verified: false, reason: 'not_found', detail: `读不到 ${tag}` };
  }
  if (reading.status !== 'ok') {
    // **不是 ok 就不能说「确认生效」**——
    // stale 的值是**旧的**（板子可能还没进目标状态），unavailable/error 更不用说了。
    return {
      ok: false,
      verified: false,
      reason: 'failed',
      status: reading.status,
      actual: reading.value,
      detail: reading.detail ?? `${tag} 的状态是 ${reading.status}，不能算确认生效`,
    };
  }
  if (spec.expect === undefined) {
    // 没有 expect → 读到就是确认（形式 1 的默认用法）
    return { ok: true, verified: true, value: reading.value, unit: reading.unit, status: reading.status };
  }
  const expected = substitute(String(spec.expect), params.raw);
  if (!sameValue(reading.value, expected)) {
    return {
      ok: false,
      verified: false,
      reason: 'readback_mismatch',
      expected,
      actual: reading.value,
      detail: '回读到的值与期望不符',
    };
  }
  return { ok: true, verified: true, value: reading.value, unit: reading.unit, status: reading.status };
}

/** 形式 2：读文件比值 */
async function readFileForm(
  spec: ReadbackDef,
  params: ReadbackParams,
  deps: ReadbackDeps,
): Promise<ReadbackResult> {
  const path = substitute(String(spec.path ?? ''), params.raw);
  const content = await deps.readFile(path);
  if (content === null) {
    return { ok: false, verified: false, reason: 'not_found', detail: `读不到 ${path}` };
  }
  const actual = content.trim();
  const expected = substitute(String(spec.expect ?? ''), params.raw);
  const tolerance = spec.tolerance;
  const matches =
    tolerance === undefined
      ? actual === expected
      : (() => {
          const a = Number(actual);
          const b = Number(expected);
          return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
        })();
  if (!matches) {
    return {
      ok: false,
      verified: false,
      reason: 'readback_mismatch',
      expected,
      actual,
      detail: '回读到的值与期望不符',
    };
  }
  return { ok: true, verified: true, value: actual, detail: `${path} = ${actual}` };
}

/** 形式 3：动作自己那条命令的退出码 */
function commandOkForm(
  deps: ReadbackDeps,
  actionResult: ExecResult | undefined,
): ReadbackResult {
  if (!deps.hasExitCode) {
    return {
      ok: false,
      verified: false,
      reason: 'unsupported_transport',
      detail: '这条连接没有退出码（串口），command_ok 用不了',
    };
  }
  if (actionResult === undefined) {
    return { ok: false, verified: false, reason: 'failed', detail: '没有动作的执行结果可比' };
  }
  if (actionResult.timedOut) {
    return { ok: false, verified: false, reason: 'timeout', detail: '动作那条命令超时了' };
  }
  // **被取消了** → 退出码是 `null` ✓（不是 0、也不是 124 ✓）
  // → 不看这个标志的话，它会掉进「返回非 0」那一档 ✗
  // → 报「回读不符」是**撒谎** ✗（人叫停 ≠ 板子不听话 ✓）
  if (actionResult.cancelled === true) {
    return { ok: false, verified: false, reason: 'cancelled', detail: '动作那条命令被取消了' };
  }
  if (actionResult.exitCode !== 0) {
    return {
      ok: false,
      verified: false,
      reason: 'readback_mismatch',
      expected: 0,
      actual: actionResult.exitCode,
      detail: actionResult.stderr.trim() || '动作那条命令返回非零',
    };
  }
  return { ok: true, verified: true, value: actionResult.exitCode, detail: '命令返回 0' };
}

/** 形式 4：再跑一条二次验证命令，轮询到成功或超时 */
async function verifyForm(
  spec: ReadbackDef,
  params: ReadbackParams,
  deps: ReadbackDeps,
): Promise<ReadbackResult> {
  if (!deps.hasExitCode) {
    return {
      ok: false,
      verified: false,
      reason: 'unsupported_transport',
      detail: '这条连接没有退出码（串口），verify 用不了',
    };
  }
  const command = substitute(String(spec.command ?? ''), params.encoded);
  const timeoutMs = spec.timeout_ms ?? 5_000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await deps.exec(command);
    if (!result.timedOut && result.exitCode === 0) {
      return { ok: true, verified: true, value: 0, detail: '验证命令返回 0' };
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        verified: false,
        reason: 'timeout',
        detail: `验证命令在 ${timeoutMs}ms 内没成功`,
      };
    }
    await sleep(100);
  }
}

/**
 * 按回读声明取一次值。
 *
 * @param spec 板型包里声明的回读块
 * @param params 本次调用的参数（原始值 + 编码后的片段）
 * @param deps 能力（读 tag / 读文件 / 跑命令）
 * @param actionResult **动作自己那条命令**的执行结果（形式 3 看它）
 */
export async function runReadback(
  spec: ReadbackDef,
  params: ReadbackParams,
  deps: ReadbackDeps,
  actionResult?: ExecResult,
): Promise<ReadbackResult> {
  const kind = spec.kind ?? 'tag';
  switch (kind) {
    case 'tag':
      return readTagForm(spec, params, deps);
    case 'file_equals':
      return readFileForm(spec, params, deps);
    case 'command_ok':
      return commandOkForm(deps, actionResult);
    case 'verify':
      return verifyForm(spec, params, deps);
    case 'none':
      // **形式 5**：`ok: true` + **`verified: false`**——
      // 不写 `ok: false`（命令确实执行了、效果也确实有），
      // 也不写 `ok: true` 什么都不说（把「没验证」藏起来）。
      return {
        ok: true,
        verified: false,
        detail: spec.consequence ?? '这个动作没有可回读的状态',
      };
    default:
      return {
        ok: false,
        verified: false,
        reason: 'failed',
        detail: `不知道的回读形式：${kind}`,
      };
  }
}

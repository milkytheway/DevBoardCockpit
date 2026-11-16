import { createHash, randomUUID } from 'node:crypto';
import type { ActionDef, PackGuard, PackParam } from '../tags/schema';
import type { FloorVerdict } from './floor-check';

/**
 * 授权与确认 —— 契约 `docs/spec/02-board-pack.md` §5.5 + `spec/04` §2.4.1。
 *
 * ── 授权粒度 = 动作 id + 可选参数域 ──
 *
 * | 情形 | 行为 |
 * |---|---|
 * | `reversible` 且参数落在 `guard` 域内 | **直接执行**（仍记审计） |
 * | `reversible` 但参数**超出** `guard` | 走一次确认（与 destructive 同一条通道） |
 * | `destructive` | **必须有人在 GUI 里点确认** |
 * | 动作没被授权 | 拒绝 |
 * | 编码后的命令**命中危险地板** | 按 `destructive` 处理（§5.2.1） |
 *
 * **超出 guard 不是拒绝**：guard 是「装卡时批准的那一档」，
 * 超出它只是**超出了批准范围**——要人再点一次，不是直接不许。
 */

/** 已授权的动作（装卡时用户批准的） */
export interface GrantedActions {
  /**
   * 动作 id → 批准的参数域（**按参数名**，形状与动作自己的 `guard` 一样）。
   *
   * `undefined` = 批准了这个动作，但**没有缩小**参数域
   * （等价于 guard = 参数自己声明的完整域）。
   */
  actions: Record<string, Record<string, PackGuard> | undefined>;
}

/** 授权的结论 */
export type AuthorizationVerdict = 'ok' | 'needs_confirmation' | 'denied';

/** 授权结果 */
export interface AuthorizationResult {
  verdict: AuthorizationVerdict;
  /** 给人看的一句话 */
  detail?: string;
  /** 哪个参数超了域（needs_confirmation 时说清楚） */
  param?: string;
}

/** 一个值落在这个域里吗 */
function withinRange(value: unknown, range: { min?: number; max?: number } | undefined): boolean {
  if (range === undefined) return true;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (range.min !== undefined && value < range.min) return false;
  if (range.max !== undefined && value > range.max) return false;
  return true;
}

/**
 * 判断这个动作能不能直接执行。
 *
 * @param action 板型包里声明的动作
 * @param params 本次调用的**原始**参数值
 * @param granted 装卡时用户批准的动作集合
 * @param floor 危险地板的复查结果（命中 → 按 destructive 处理）
 */
export interface AuthorizeOptions {
  /**
   * **destructive 动作与超 guard 域要不要停下来问人** ✓（**默认问** ✓）。
   *
   * → **卡片那条路不问** ✓（**用户点了就是同意** ✓ —— 契约 `spec/03` §7.6 的「人点」
   *   在这一步**就是那一下点击** ✓ —— **卡片不许自己给自己放行** ✓ ≠ **点击就是人** ✓）。
   * → **agent 那条路问** ✓（**agent 不是人** ✓ —— 它必须求人点头 ✓）。
   * → **地板命中永远要人点头** ✓（**那是命令本身危险** ✓ —— **与谁点的无关** ✓）。
   */
  askForConsent?: boolean;
}

export function authorize(
  action: ActionDef,
  params: Record<string, unknown>,
  granted: GrantedActions,
  floor: FloorVerdict,
  opts: AuthorizeOptions = {},
): AuthorizationResult {
  // **这条路上要不要问人** ✓（默认问 ✓）
  const ask = opts.askForConsent !== false;
  // 1) 授权集合里有没有这个动作
  if (!Object.prototype.hasOwnProperty.call(granted.actions, action.id)) {
    return { verdict: 'denied', detail: `动作「${action.id}」没有获得授权` };
  }

  // 2) 危险等级：包声明的 **或** 地板命中的（取更严的）
  const dangerous = action.danger === 'destructive' || floor.verdict === 'destructive';
  if (dangerous) {
    // **卡片那条路不问** ✓（**用户点了就是同意** ✓ —— **地板也归它** ✓）
    //
    // → **为什么地板也归它** ✓：**板型包那条路已经查过地板了** ✓
    //   （**动作** ✓ 规则 16 ✓ · **reader** ✓ 规则 28 ✓）→ **这里是第二遍** ✓
    // → **不归它会怎样** ✓：**卡片永远卡在「等人确认」上** ✗ —— **而界面里没有那道闸** ✗
    //   → **问了就没人答** ✗ → **那是最坏的一种状态** ✗（**既不执行也不明说** ✗）
    if (!ask) return { verdict: 'ok' };
    if (floor.verdict === 'destructive') {
      return {
        verdict: 'needs_confirmation',
        detail: `命令命中了危险地板（${floor.why ?? '危险命令'}），按破坏性处理，要人确认`,
      };
    }
    return {
      verdict: 'needs_confirmation',
      detail: `动作「${action.id}」是破坏性的，要人确认`,
    };
  }

  // 3) 参数域：**装卡时批准的那一档优先**，没有就用动作自己的 `guard`，
  //    再没有就用参数自己声明的域
  //    （契约 §5.5：「没有声明 guard → 等价于 guard = 参数的完整声明域」）
  const grantedDomain = granted.actions[action.id];
  const guard = action.guard ?? {};
  for (const [name, spec] of Object.entries(action.params ?? {})) {
    const paramSpec = spec as PackParam;
    // **参数域只管数值参数**——min/max 是数字，
    // 套到 string/enum 上只会得到「永远超出」这种假拒绝。
    // （字符串的长度由 `maxLength` 管，编码器已经拒了。）
    if (paramSpec.type !== 'integer' && paramSpec.type !== 'number') continue;
    const range =
      grantedDomain?.[name] ?? guard[name] ?? { min: paramSpec.min, max: paramSpec.max };
    if (!withinRange(params[name], range)) {
      // **卡片那条路：超范围 → 拒绝** ✓（**不放行** ✓）
      //
      // → **guard 是包作者划的界** ✓（例：背光 0–15「太暗、看着像屏幕坏了」✓）
      //   → **它不是「问人的触发条件」** ✓ → **要么守着，要么问** ✓
      //   → **守着** ✓（**卡片那条路没有「问」这个动作** ✓ —— **界面上没有那道闸** ✗）
      if (!ask) {
        return {
          verdict: 'denied',
          param: name,
          detail: `参数「${name}」超出了这个动作允许的范围（${describeRange(range)}）`,
        };
      }
      return {
        verdict: 'needs_confirmation',
        param: name,
        detail: `参数「${name}」超出了批准的范围（${describeRange(range)}），要人确认`,
      };
    }
  }

  return { verdict: 'ok' };
}

/** 把范围说成人话 */
function describeRange(range: { min?: number; max?: number }): string {
  if (range.min !== undefined && range.max !== undefined) return `${range.min} .. ${range.max}`;
  if (range.min !== undefined) return `≥ ${range.min}`;
  if (range.max !== undefined) return `≤ ${range.max}`;
  return '（没有限制）';
}

/** 凭据的有效期（5 分钟） */
export const CONFIRM_TTL_MS = 5 * 60_000;

/** 参数的规范化摘要（凭据绑的是「这一次的这些参数」） */
export function paramsDigest(params: Record<string, unknown>): string {
  const normalized = Object.keys(params)
    .sort()
    .map((key) => `${key}=${JSON.stringify(params[key])}`)
    .join('&');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

/**
 * 确认凭据的签发与消费。
 *
 * ── 凭据绑什么 ──
 *
 * `(动作 id, 参数规范化摘要, 板型包 id, 契约版本)` —— 一次确认**只**管这一次。
 * 改了参数、换了动作、换了包、契约升了版 → 原来的确认**作废**。
 *
 * ── 一次性 ──
 *
 * 用掉就没了（重放 = 绕过确认）。
 */
export class ConfirmationStore {
  /**
   * 凭据的状态。
   *
   * ── 为什么要有「待确认」这一档 ──
   *
   * 契约 `spec/04` §2.4.1 说得很死：
   * > 「这个工具**不返回可直接使用的凭据**……真正的确认要等**人**点了之后，
   * > `confirm_id` 才有效。**没有人点，`confirm_id` 永远无效。**」
   *
   * → 所以凭据**签发 ≠ 有效** ✓：
   * `issue()` 把它挂成**待确认** ✓ → **人点了**（`approve()` ✓）→ 才**可用** ✓。
   *
   * → **没有这一档 = 「谁要谁批」** ✗：
   * 拿到 `needs_confirmation` 的那一方**自己就能重试成功** ✓ → 确认通道形同虚设 ✗。
   */
  private readonly issued = new Map<
    string,
    { digest: string; at: number; state: 'pending' | 'approved' }
  >();

  /**
   * 签发一张凭据（**待确认** —— 还不能用来执行 ✓）。
   *
   * @returns 凭据串（给 agent 拿去重试）
   */
  issue(
    actionId: string,
    params: Record<string, unknown>,
    packId: string,
    contractVersion: string,
    now: number,
    /**
     * **这一步最终命令的摘要** ✓（契约 `spec/05` §7.5-3 ✓）。
     *
     * → 为什么要有它 ✓：最终命令是**消费时现算**的 ✓，
     *   而命令里的 `{output:槽}` / `{from.path}` / `{to.path}` **不在参数摘要里** ✓
     *   → 不绑它 ✓ → **同一张凭据认得两条不同的命令** ✗
     */
    commandDigest: string,
    /**
     * **这一步动的是哪块板** ✓（契约 `spec/04` §2.4.1 的**第六项** ✓）。
     *
     * → **为什么现在加** ✓：将来多设备时 ✓，一张为 A 板签发的凭据
     *   能拿去动 B 板 ✗ → **那时再加绑定项同样是破坏性变更** ✗ → **现在加** ✓。
     */
    deviceKey: string,
  ): string {
    const token = `${randomUUID()}`;
    this.issued.set(token, {
      digest: `${actionId}|${paramsDigest(params)}|${packId}|${contractVersion}|${commandDigest}|${deviceKey}`,
      at: now,
      state: 'pending',
    });
    return token;
  }

  /**
   * **人点了确认** → 这张凭据才**可用** ✓。
   *
   * → 这是「人点头」那一下的**唯一入口** ✓。
   *
   * ── 谁可以调它 ──
   *
   * **只有人点的路径** ✓：
   * - GUI 的确认按钮 ✓（人在界面上点了 ✓）；
   * - 命令行 `npm run workflow:confirm -- <runId> <confirmId>` ✓（人自己敲的 ✓）。
   *
   * → **agent 调不到它** ✓（评审 37 的 V3-C1 ✓）：
   * agent 能做的是「**请求**一次确认」（`request()` ✓），
   * 那只是**把请求递进 GUI 队列** ✓ —— 凭据**仍然无效** ✓
   * （契约 `spec/04` §2.4.1 的原话：「没有人点，confirm_id 永远无效」✓）。
   *
   * @returns 批不批（凭据不存在 / 已过期 → false ✓）
   */
  approve(token: string, now: number): boolean {
    const entry = this.issued.get(token);
    if (entry === undefined) return false;
    if (now - entry.at > CONFIRM_TTL_MS) {
      this.issued.delete(token);
      return false;
    }
    entry.state = 'approved';
    return true;
  }

  /** 这张凭据**是不是已经被人点过**（诊断用 ✓） */
  isApproved(token: string): boolean {
    return this.issued.get(token)?.state === 'approved';
  }

  /**
   * **撤销**一张凭据（**作废** ✓ —— 不能再被批准 ✓）。
   *
   * → 取消一次运行的时候用得上 ✓（独立评审 40 的 I-8 ✓）：
   * 人**不该**再去点一个已经被取消的运行 ✗（那是一条挂在队列里的僵尸请求 ✓）。
   *
   * @returns 有没有这张凭据（没有 → false ✓）
   */
  revoke(token: string): boolean {
    if (!this.issued.has(token)) return false;
    this.issued.delete(token);
    return true;
  }

  /**
   * **请求**一次确认（**agent 唯一能做的事** ✓）。
   *
   * → 它**不批准任何东西** ✓：只是把请求**递进 GUI 的确认队列** ✓。
   * → 凭据仍是**待确认** ✓ → 没人点，它就永远无效 ✓。
   *
   * → **为什么要有这个方法**（评审 37 的 V3-C1 ✓）：
   * agent 需要一个「把我的请求递给用户」的通道 ✓，
   * 但**不能**有「我自己批准」的通道 ✗。
   */
  request(token: string, now: number): boolean {
    const entry = this.issued.get(token);
    if (entry === undefined) return false;
    if (now - entry.at > CONFIRM_TTL_MS) {
      this.issued.delete(token);
      return false;
    }
    // **状态不变**（还是 'pending' ✓）——只是「有人在等」✓
    return true;
  }

  /**
   * 用掉一张凭据（**一次性**）。
   *
   * @returns 凭据对得上吗（对得上就把它作废）
   */
  consume(
    token: string,
    actionId: string,
    params: Record<string, unknown>,
    packId: string,
    contractVersion: string,
    now: number,
    /** **这一步最终命令的摘要** ✓（与签发时算的那份必须是同一个 ✓） */
    commandDigest: string,
    /** **这一步动的是哪块板** ✓（与签发时必须是同一个 ✓ —— 契约 §2.4.1 第六项 ✓） */
    deviceKey: string,
  ): boolean {
    const entry = this.issued.get(token);
    if (entry === undefined) return false;
    // 过期 → 删掉，不行
    if (now - entry.at > CONFIRM_TTL_MS) {
      this.issued.delete(token);
      return false;
    }
    // **没被人点过 → 不能用**（契约 spec/04 §2.4.1 ✓）
    if (entry.state !== 'approved') return false;
    const expected = `${actionId}|${paramsDigest(params)}|${packId}|${contractVersion}|${commandDigest}|${deviceKey}`;
    if (entry.digest !== expected) return false;
    // **一次性**：用掉就删
    this.issued.delete(token);
    return true;
  }
}

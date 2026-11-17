import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * **统一权限区**（用户 2026-11-16：「设置里面补一个统一的权限区域，
 * 所有元操作可以在这里设置是否有权限执行」✓ · **ADR-D47** ✓）。
 *
 * ── 为什么要有它 ──
 *
 * → 授权**散在好几个地方** ✗（装卡时问一次 ✓ · 跑流程前问一次 ✓ ·
 *   危险命令前问一次 ✓ · 执行前问一次 ✓）→ **「这个也要同意那个也要同意」** ✗。
 * → **一个地方** ✓：**设置里一列操作，每条一个开关** ✓ —— **想关就关** ✓。
 * → **不再有弹窗** ✓ —— **开关是可见的** ✓，弹窗是打断人的 ✓。
 *
 * ── 两种执行者（**分开** ✓）──
 *
 * | 执行者 | 谁能触发 | 默认 |
 * |---|---|---|
 * | **卡片** | **界面上的卡** ✓（用户点它的按钮 ✓） | **写板子：禁止** ✓ · **触发流程：允许** ✓ |
 * | **agent** | **MCP 那条路** ✓（agent 调工具 ✓） | **允许** ✓（**危险的那类默认关** ✓ —— **两种执行者一个规矩** ✓） |
 *
 * → **卡片默认不许写板子** ✓ —— **这堵住了 C2** ✓：
 *   **宿主分不出「人点了卡片上的按钮」与「卡片自己的 JS 调了同一个 API」** ✗
 *   → 所以**默认不给** ✓ → **要写板子的人在设置里打开** ✓（**一次** ✓ · **可见** ✓）。
 * → **agent 那条路不受影响** ✓ —— **它自己那行开关说了算** ✓
 *   （**`confirm_action` 那套 2026-11-16 没了** ✓ · ADR-D48 ✓）。
 *
 * ── 操作的键 ──
 *
 * `action:<动作 id>` ✓ · `workflow:<流程 id>` ✓ · `host:<宿主操作>` ✓
 * → **带前缀** ✓ —— **免得动作 id 与流程 id 撞车** ✓。
 */
export type PermissionActor = 'card' | 'agent';

/** 一类操作 */
export type PermissionKind = 'action' | 'workflow' | 'host';

/** 操作键的前缀（**封闭** ✓） */
export const KIND_PREFIX: Record<PermissionKind, string> = {
  action: 'action:',
  workflow: 'workflow:',
  host: 'host:',
};

/**
 * **已知操作**（**由宿主填** ✓ —— **每换一块板就重算** ✓）。
 *
 * → **带危险等级** ✓ —— **默认规则要靠它** ✓（「危险的动作默认关」✓）。
 */
const KNOWN_OPS = new Map<string, PermissionOperation>();

/** 宿主侧的操作（**固定的那几个** ✓ —— **每个都要能被关掉** ✓） */
export const HOST_OPERATIONS = [
  'install_card',
  'uninstall_card',
  'promote_card',
] as const;

/**
 * **默认**（**没设过的操作按这个来** ✓）。
 *
 * → **卡片写板子：禁止** ✓（C2 ✓）
 * → **卡片触发流程：允许** ✓（**闸就是这行开关** ✓ —— 「编译上板」那张卡
 *   点一下就执行 ✓ —— **那正是用户要的** ✓）
 * → **agent：允许** ✓（**它那边也是同一行开关** ✓）
 * → **宿主操作：允许** ✓
 */
export function defaultAllowed(
  actor: PermissionActor,
  op: string,
  dangerous = false,
): boolean {
  // **危险的动作：默认关** ✓（**「开启权限默认知道危险性」** ✓ —— **打开它就是那一下知情** ✓）
  if (dangerous) return false;
  if (actor === 'agent') return true;
  // **卡片**：只有「写板子」这一类是禁止的 ✓
  if (op.startsWith(KIND_PREFIX.action)) return false;
  return true;
}

/** 一条操作在设置里长什么样 */
export interface PermissionOperation {
  /** 操作的键（`action:backlight.set` ✓） */
  op: string;
  /** 显示名 */
  label: string;
  /** 这一类 */
  kind: PermissionKind;
  /** 这一类里的说明（**人话** ✓） */
  hint?: string;
  /** **这个动作有多危险** ✓（**动作才有** ✓ —— **流程靠「存在即说明」** ✓） */
  danger?: 'reversible' | 'destructive';
}

/** 设置页要画的那张表（**一行一个开关** ✓） */
export interface PermissionRow extends PermissionOperation {
  /** 卡片能不能用 */
  card: boolean;
  /** agent 能不能用 */
  agent: boolean;
}

/** 存盘的形状 */
interface PolicyFile {
  card: Record<string, boolean>;
  agent: Record<string, boolean>;
}

/**
 * 权限账（**用户数据目录里** ✓ —— **机器专属的授权状态不进版本库** ✓）。
 *
 * → **读不出来就算「默认」** ✓（**默认拒绝的是卡片写板子** ✓ —— **安全的那一边** ✓）。
 */
export class PermissionStore {
  /** **这张表里有哪些操作**（**宿主每次列表时更新** ✓） */
  setKnown(operations: readonly PermissionOperation[]): void {
    KNOWN_OPS.clear();
    for (const operation of operations) KNOWN_OPS.set(operation.op, operation);
  }

  private readonly policy: PolicyFile = { card: {}, agent: {} };

  constructor(private readonly filePath: string) {
    this.load();
  }

  /** 这个执行者能不能用这个操作 */
  allows(actor: PermissionActor, op: string): boolean {
    const explicit = this.policy[actor][op];
    if (explicit !== undefined) return explicit;
    return defaultAllowed(actor, op, this.isDangerous(op));
  }


  /** 设一个（**幂等** ✓） */
  set(actor: PermissionActor, op: string, allowed: boolean): void {
    if (this.policy[actor][op] === allowed) return;
    this.policy[actor][op] = allowed;
    this.save();
  }

  /**
   * **这个操作存在吗**（**设一个不存在的操作是不行的** ✓）。
   *
   * → **不查就会存下一堆垃圾键** ✓（**而且没人看得见** ✓）✓
   */
  knows(op: string): boolean {
    return KNOWN_OPS.has(op);
  }

  /** **这个操作有多危险** ✓（**设置页要写着** ✓ —— 「开启权限默认知道危险性」✓） */
  dangerOf(op: string): 'reversible' | 'destructive' | undefined {
    return KNOWN_OPS.get(op)?.danger;
  }

  /** **它是不是危险动作** ✓（**默认关** ✓ —— **打开它就是那一下知情** ✓） */
  private isDangerous(op: string): boolean {
    return KNOWN_OPS.get(op)?.danger === 'destructive';
  }

  /** 全部（**给设置页看** ✓ —— 显式的与默认的合成 ✓） */
  rows(operations: readonly PermissionOperation[]): PermissionRow[] {
    return operations.map((operation) => ({
      ...operation,
      card: this.allows('card', operation.op),
      agent: this.allows('agent', operation.op),
    }));
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<PolicyFile>;
      this.policy.card = { ...(parsed.card ?? {}) };
      this.policy.agent = { ...(parsed.agent ?? {}) };
    } catch {
      // **读不出来 → 用默认** ✓（**默认里卡片写板子是禁止** ✓ —— 安全的那一边 ✓）
      this.policy.card = {};
      this.policy.agent = {};
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.policy, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
  }
}

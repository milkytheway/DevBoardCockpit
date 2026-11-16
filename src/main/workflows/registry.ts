import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { makeError } from '../../shared/errors';
import { parseWorkflow, type WorkflowPack } from './format';

/**
 * 流程包**注册表** —— 「哪些流程可以跑」这本账。
 *
 * ── 为什么要有它（两份独立评审的同一条 Critical）──
 *
 * 评审 32 的原话：**「agent 可以自写一个流程包然后跑它」**。
 * → 原因很直白：**一个流程包就是「一组要在用户机器上执行的命令」**，
 * 而 `npm run workflow:run -- --package <任意路径>` **只认路径，不认人**。
 *
 * → 于是「谁批准了这个包」这件事**根本没有地方记** ✗。
 *
 * ── 这本账怎么记 ──
 *
 * | 账 | 记什么 | 谁能改 |
 * |---|---|---|
 * | **注册表** | 目录里有哪些包（id → 包 + **内容摘要**） | 放文件进目录 |
 * | **批准账** | 哪些包**被用户批准过**（id → 摘要 + 时刻） | **只有人能改**（`npm run workflow:approve`） |
 *
 * → **放一个文件进目录 ≠ 批准它** ✓（否则「能写文件」就等于「能执行命令」✗）。
 * → **批准绑内容摘要** ✓：改了内容 → 摘要变了 → **要重新批准** ✓
 * （否则「批准 A 版、跑 B 版」✗）。
 *
 * ── 与卡片那一套同形 ──
 *
 * 卡片那边是「**卡片在目录里** + **授权账（grants.json）说用户批过哪些动作**」✓；
 * 这边是「**流程包在目录里** + **批准账说用户批过哪些包**」✓ → 一个模型 ✓。
 */
export interface RegisteredWorkflow {
  /** 包里的 id */
  id: string;
  /** 包的名字 */
  name: string;
  /** 版本 */
  version: string;
  /** 文件在哪 */
  path: string;
  /** **内容摘要**（批准绑它 ✓） */
  digest: string;
  /** 解析出来的包 */
  pack: WorkflowPack;
}

/**
 * 一个流程包**会干什么**的摘要（**给人过目** ✓）。
 */
export interface WorkflowPlan {
  id: string;
  name: string;
  /** 角色 → 它连的是哪台机器（**profile id** ✓） */
  roles: { role: string; purpose: string; profile: string }[];
  /** 每个写步骤：在哪跑、跑什么、危不危险、判据读在哪 */
  steps: {
    id: string;
    kind: string;
    /** 执行角色（判据步是「在哪个角色上读」✓） */
    role?: string;
    /** 命令**模板**（**还没替换输入** ✓ —— 批准时不知道输入值 ✓） */
    command?: string;
    /** 这一步危险吗（destructive → **运行期还要再确认一次** ✓） */
    dangerous: boolean;
    /** 判据读在哪个角色上（跨目标读 = 「板子上真的有那个文件吗」✓） */
    readbackRole?: string;
  }[];
}

/** 摘要一个流程包 */
export function planOf(pack: WorkflowPack): WorkflowPlan {
  return {
    id: pack.id,
    name: pack.name,
    roles: Object.entries(pack.roles).map(([role, r]) => ({
      role,
      purpose: r.purpose,
      profile: r.profile,
    })),
    steps: pack.steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      ...(step.role === undefined ? {} : { role: step.role }),
      ...(step.cmd === undefined ? {} : { command: step.cmd }),
      dangerous: step.danger === 'destructive',
      ...(step.readback?.role === undefined ? {} : { readbackRole: step.readback.role }),
    })),
  };
}

/** 批准账的存盘形状 */
export interface WorkflowRegistryOptions {
  /** 包目录（内置的 + 用户的，**同 id 时用户优先** ✓） */
  dirs: string[];
  /** 记警告的出口 */
  warn?: (message: string) => void;
  /** 现在（毫秒） */
  now?: () => number;
}

/** 内容摘要（sha256，前 16 位够用 —— 它的作用是「变了没有」，不是防篡改 ✓） */
export function digestOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

export class WorkflowRegistry {
  private readonly warn: (message: string) => void;
  private packs = new Map<string, RegisteredWorkflow>();

  constructor(private readonly opts: WorkflowRegistryOptions) {
    this.warn = opts.warn ?? ((m: string) => console.warn(m));
  }

  /** 扫目录，重新登记（**坏包不拖垮其余** ✓ —— 与 profile 加载器同规矩 ✓） */
  scan(): void {
    this.packs = new Map();

    // **后扫的覆盖先扫的** → 用户目录放在后面 ✓（同 id 时用户优先 ✓）
    for (const dir of this.opts.dirs) {
      if (!existsSync(dir)) continue;
      let files: string[];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!/\.(ya?ml)$/i.test(file)) continue;
        const path = join(dir, file);
        let raw: string;
        try {
          raw = readFileSync(path, 'utf8');
        } catch (err) {
          this.warn(`跳过读不了的流程包 ${path}：${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        let pack: WorkflowPack;
        try {
          pack = parseWorkflow(yaml.load(raw), path);
        } catch (err) {
          this.warn(`跳过坏的流程包 ${path}：${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        const digest = digestOf(raw);
        this.packs.set(pack.id, {
          id: pack.id,
          name: pack.name,
          version: pack.version,
          path,
          digest,
          pack,
        });
      }
    }
  }

  /**
   * 这个包**会干什么**（**给人过目的** ✓）。
   *
   * → 「点一下批准」之前，人必须知道**会在哪些机器上跑哪些命令** ✓
   *   （评审 35 的 32-C1 建议第 2 条 ✓）。
   * → 没有这一条，批准就只是「批准一个文件名」✓ → **等于没看** ✗。
   */
  planOf(id: string): WorkflowPlan | undefined {
    const found = this.packs.get(id);
    if (found === undefined) return undefined;
    return planOf(found.pack);
  }

  /** 列全部（**含未批准的** ✓ —— 用户要看得见「有个包还没批」） */
  list(): RegisteredWorkflow[] {
    return [...this.packs.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** 按 id 取一个包（**不检查批准** ✓ —— 调用方自己决定要不要查 ✓） */
  get(id: string): RegisteredWorkflow | undefined {
    return this.packs.get(id);
  }

  /**
   * 按 id 取一个包。
   *
   * → **不再有「已批准」那一层** ✓（2026-11-16 ✓ · ADR-D48 ✓）——
   *   **流程包的存在本身就是说明** ✓（**权限区里那一行开关才是闸** ✓ —— ADR-D47 ✓）。
   *
   * @throws 没这个包 → `IPC_INVALID_PAYLOAD` ✓
   */
  require(id: string): RegisteredWorkflow {
    const found = this.packs.get(id);
    if (found === undefined) {
      // **带上机器可读的 reason** ✓（MCP 那一层要把它回给 agent ✓ —— 契约 §四 ✓；
      // 不然只能靠中文消息猜 ✓ —— 那是「解析错误消息」的坏味道 ✗）
      throw makeError('IPC_INVALID_PAYLOAD', `没有这个流程包：${id}`, {
        detail: { id, reason: 'not_found' },
      });
    }
    return found;
  }

  /**
  /** 收回批准 */
}

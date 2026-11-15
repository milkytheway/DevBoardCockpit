import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  /** 用户批过吗（摘要对得上才算 ✓） */
  approved: boolean;
  /** 批准的时刻（没批过 = undefined） */
  approvedAt?: number;
}

/** 批准账的存盘形状 */
interface ApprovalFile {
  workflows: Record<string, { digest: string; at: number }>;
}

export interface WorkflowRegistryOptions {
  /** 包目录（内置的 + 用户的，**同 id 时用户优先** ✓） */
  dirs: string[];
  /** 批准账的文件路径 */
  approvalFile: string;
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
  private readonly now: () => number;
  private packs = new Map<string, RegisteredWorkflow>();

  constructor(private readonly opts: WorkflowRegistryOptions) {
    this.warn = opts.warn ?? ((m: string) => console.warn(m));
    this.now = opts.now ?? (() => Date.now());
  }

  /** 扫目录，重新登记（**坏包不拖垮其余** ✓ —— 与 profile 加载器同规矩 ✓） */
  scan(): void {
    this.packs = new Map();
    const approvals = this.readApprovals();

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
        const approval = approvals[pack.id];
        this.packs.set(pack.id, {
          id: pack.id,
          name: pack.name,
          version: pack.version,
          path,
          digest,
          pack,
          // **摘要对得上才算批准** ✓（改了内容 → 要重新批 ✓）
          approved: approval !== undefined && approval.digest === digest,
          ...(approval === undefined ? {} : { approvedAt: approval.at }),
        });
      }
    }
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
   * 按 id 取一个**已批准**的包。
   *
   * @throws 没这个包 / 没批准 → `IPC_INVALID_PAYLOAD`（**说清楚是哪一种** ✓）
   */
  requireApproved(id: string): RegisteredWorkflow {
    const found = this.packs.get(id);
    if (found === undefined) {
      throw makeError('IPC_INVALID_PAYLOAD', `没有这个流程包：${id}`, { detail: { id } });
    }
    if (!found.approved) {
      throw makeError('IPC_INVALID_PAYLOAD', `流程包「${id}」还没有被批准`, {
        detail: { id, digest: found.digest },
      });
    }
    return found;
  }

  /**
   * 批准一个包（**只有人能调到这里** ✓ —— 这是「点头」那一下 ✓）。
   *
   * → 记的是**当前内容的摘要** ✓ → 改了内容要重新批 ✓。
   */
  approve(id: string): RegisteredWorkflow {
    const found = this.packs.get(id);
    if (found === undefined) {
      throw makeError('IPC_INVALID_PAYLOAD', `没有这个流程包：${id}`, { detail: { id } });
    }
    const approvals = this.readApprovals();
    approvals[id] = { digest: found.digest, at: this.now() };
    this.writeApprovals(approvals);
    found.approved = true;
    found.approvedAt = approvals[id]?.at;
    return found;
  }

  /** 收回批准 */
  revoke(id: string): void {
    const approvals = this.readApprovals();
    delete approvals[id];
    this.writeApprovals(approvals);
    const found = this.packs.get(id);
    if (found !== undefined) {
      found.approved = false;
      found.approvedAt = undefined;
    }
  }

  private readApprovals(): Record<string, { digest: string; at: number }> {
    if (!existsSync(this.opts.approvalFile)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.opts.approvalFile, 'utf8')) as ApprovalFile;
      return parsed.workflows ?? {};
    } catch {
      // **读不出来就当没批过**（默认拒绝 ✓ —— 比默认放行安全 ✓）
      return {};
    }
  }

  private writeApprovals(approvals: Record<string, { digest: string; at: number }>): void {
    mkdirSync(join(this.opts.approvalFile, '..'), { recursive: true });
    const tmp = `${this.opts.approvalFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ workflows: approvals }, null, 2), 'utf8');
    // **改名是原子的** → 断电不会留下半个文件 ✓（与授权账同款 ✓）
    renameSync(tmp, this.opts.approvalFile);
  }
}

/** 批准账的文件路径（**在用户数据目录里** ✓ —— 与授权账同处 ✓） */
export function workflowApprovalsFile(dataDir: string): string {
  return join(dataDir, 'workflows-approved.json');
}

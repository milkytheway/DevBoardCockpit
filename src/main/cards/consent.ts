import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * **装卡的同意队列**（契约 `spec/04` §2.3 ✓ · ADR-D40 ✓）。
 *
 * ── 为什么同意要绑 manifest 哈希 ──
 *
 * `validate_card(path)` 与 `install_card(path)` 之间，**文件可能被换掉** ✓
 * —— 包括**被另一个进程换掉** ✓。
 * → 若授权只绑「卡片 id」✓，**用户批准的是 A 的 manifest，装上去的却是 B** ✗。
 * → 绑哈希把「人批准的那份东西」与「实际装上的那份东西」**钉在一起** ✓。
 *
 * ── 三条绑定规则（契约 §2.3 的表 ✓）──
 *
 * | 项 | 规则 |
 * |---|---|
 * | **绑定** | `(manifest 的内容哈希, 目录快照)` ✓ |
 * | **文件变化** | manifest 或目录内容在校验与授权之间变了 → **同意失效** ✓ |
 * | **一次性** | 消费即失效 ✓；重试用同一个只允许一次 ✓ |
 * | **有效期** | 默认 5 分钟 ✓ |
 *
 * ── 「目录快照」是什么 ──
 *
 * **目录里所有文件路径 + 各自内容哈希** ✓ → 排成一份摘要 ✓。
 * → 改任何一个文件都变 ✓（**不只是 manifest** ✓ —— 入口文件被换了也得重新批 ✓）。
 */
export interface ConsentRequest {
  /** 同意凭据的 id（**agent 拿着它重试** ✓） */
  id: string;
  /** 卡片 id */
  cardId: string;
  /** **目录快照的哈希** ✓（批的是这一刻的目录 ✓） */
  snapshot: string;
  /** 待批的动作清单 */
  pending: Array<{ action: string; danger: 'reversible' | 'destructive'; label?: string; guard?: unknown }>;
  /** 请求的时刻（毫秒） */
  at: number;
  /** 过期时刻（毫秒） */
  expiresAt: number;
  /**
   * **人批过了吗** ✓。
   *
   * → **不能靠「pending 清空」表示** ✓ —— 那样**批完的请求就找不到了** ✓
   *   → agent 重试时**永远匹配不到** ✗ → **同意流程走不通** ✗。
   * → **显式一个标记** ✓（清空 pending 只是「没有待批的了」✓）。
   */
  approved: boolean;
}

/** 同意的默认有效期（**5 分钟** ✓ —— 契约 §2.3 ✓） */
export const CONSENT_TTL_MS = 5 * 60_000;

/**
 * **一个目录的快照哈希** ✓。
 *
 * → **递归** ✓（入口文件在子目录里也要算 ✓）
 * → **跳过** `node_modules` 与 `.git` ✓（**不是卡的一部分** ✓ —— 装它也没用 ✓）
 * → **路径与内容都算** ✓（**改名也算变** ✓ —— 内容一样但路径不同 → 装出来不一样 ✓）
 */
export function dirSnapshot(dir: string): string {
  const parts: string[] = [];
  walk(dir, dir, parts);
  parts.sort();
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
}

function walk(root: string, current: string, parts: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(current);
  } catch {
    return;
  }
  for (const name of entries.sort()) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = join(current, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(root, full, parts);
      continue;
    }
    if (!st.isFile()) continue;
    const rel = relative(root, full).split(sep).join('/');
    let hash = '';
    try {
      hash = createHash('sha256').update(readFileSync(full)).digest('hex');
    } catch {
      hash = 'unreadable';
    }
    parts.push(`${rel}:${hash}`);
  }
}

/**
 * **待同意的队列** ✓。
 *
 * → **在内存里** ✓（**重启即失** ✓ —— 跟确认凭据一个口径 ✓ —— 那是**安全的一边** ✓：
 *   重启后那些「人点过头」的记录消失 ✓ → agent 得**重新求** ✓）。
 * → **谁能批** ✓：**只有 GUI 那条路** ✓（`approve` ✓）—— **agent 调不到** ✓（契约 §2.4.1 ✓）。
 */
export class ConsentQueue {
  private readonly requests = new Map<string, ConsentRequest>();

  /**
   * 提一个请求（**agent 的唯一动作** ✓ —— 契约 §2.3：「agent 把请求递出去，然后重试」✓）。
   *
   * @param cardId 卡片 id
   * @param snapshot **这一刻的目录快照** ✓（**绑它** ✓）
   * @param pending 待批的动作清单
   */
  request(
    cardId: string,
    snapshot: string,
    pending: ConsentRequest['pending'],
    now = Date.now(),
  ): ConsentRequest {
    const req: ConsentRequest = {
      id: `c-${createHash('sha256')
        .update(`${cardId}|${snapshot}|${now}|${Math.random()}`)
        .digest('hex')
        .slice(0, 12)}`,
      cardId,
      snapshot,
      pending,
      at: now,
      expiresAt: now + CONSENT_TTL_MS,
      approved: false,
    };
    this.requests.set(req.id, req);
    return req;
  }

  /** 取一个请求（**没有就是 `null`** ✓ —— 不猜 ✓） */
  get(id: string, now = Date.now()): ConsentRequest | null {
    const req = this.requests.get(id);
    if (req === undefined) return null;
    if (now > req.expiresAt) {
      this.requests.delete(id);
      return null;
    }
    return req;
  }

  /** 这个人点了「同意」✓（**只有 GUI 那条路调它** ✓） */
  approve(id: string, now = Date.now()): boolean {
    const req = this.get(id, now);
    if (req === null) return false;
    // **显式标记「已批」** ✓ —— **不清空 pending** ✓
    // （清空 = 「没有待批的了」✓ —— **那是另一件事** ✓）
    req.approved = true;
    this.requests.set(id, req);
    return true;
  }

  /** 这个人点了「拒绝」✓ —— **作废** ✓（**不许再消费** ✓） */
  rejectSome(id: string, now = Date.now()): boolean {
    const req = this.get(id, now);
    if (req === null) return false;
    req.approved = false;
    req.pending = [];
    this.requests.set(id, req);
    return true;
  }

  /** 这个人点了「拒绝」✓ —— **作废** ✓ */
  reject(id: string): boolean {
    return this.requests.delete(id);
  }

  /**
   * **消费一次同意** ✓（**一次性** ✓ —— 契约 §2.3 ✓）。
   *
   * → **快照对不上就不给** ✓（文件在批与装之间变了 ✓ → 重新征求 ✓）。
   * → **用过就作废** ✓（**重放 = 绕过授权** ✗）。
   */
  consume(id: string, snapshot: string, now = Date.now()): boolean {
    const req = this.get(id, now);
    if (req === null) return false;
    // **没批过 → 不认** ✓（**签发 ≠ 批准** ✓ —— 同确认凭据那套 ✓）
    if (!req.approved) return false;
    // **快照变了 → 不认** ✓
    if (req.snapshot !== snapshot) {
      this.requests.delete(id);
      return false;
    }
    // **一次性** ✓
    this.requests.delete(id);
    return true;
  }

  /** 这个卡片的请求（**待批的 + 已批的** ✓ —— **已批的还要能被消费** ✓） */
  forCard(cardId: string, now = Date.now()): ConsentRequest[] {
    return [...this.requests.values()].filter(
      (r) => r.cardId === cardId && now <= r.expiresAt,
    );
  }

  /** 这个卡片有没有**待批**的请求（**给 agent 看「还在等」** ✓） */
  pendingFor(cardId: string, now = Date.now()): ConsentRequest[] {
    return this.forCard(cardId, now).filter((r) => !r.approved && r.pending.length > 0);
  }
}

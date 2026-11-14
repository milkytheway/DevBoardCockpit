import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PackGuard } from '../tags/schema';

/**
 * 「已授权的动作」这份账 —— 契约 `docs/spec/03-card-manifest.md` §3.3 / §2.4。
 *
 * > 「卡片**不能**在运行时请求新权限。权限只在安装时确定。
 * > ……**改 manifest 会重新征求授权。**」
 *
 * ── 为什么必须是**两份** ──
 *
 * | | 谁说的 | 少了它会怎样 |
 * |---|---|---|
 * | `permissions.write` | **卡片自己声明**（manifest） | 宿主不知道这张卡想干什么 |
 * | **已授权** | **人点过头**（装卡时） | 一张 AI 写的卡声明 `system.reboot` 就能重启板子 |
 *
 * → **有效写权限 = 两者的交集**（`permissions.ts` 的 `effectiveWrite`）。
 *
 * ── 这份账落在哪 ──
 *
 * 用户数据目录里（**不是仓库**：机器专属的授权状态不进版本库）。
 * 装卡时的授权界面属 UI 轨（外壳由 DSH 重写）→ 宿主侧先把**机制**留好：
 * `grant()` / `revoke()` 是它要调的那两个口子。
 */
export interface CardGrant {
  /** 板型包里的动作 id */
  actionId: string;
  /**
   * 用户批准的**参数域**（按参数名，形状与动作自己的 `guard` 一样）。
   *
   * 没有 = 批准了这个动作，但**没有缩小**参数域
   * （等价于 guard = 参数自己声明的完整域）。
   */
  domains?: Record<string, PackGuard>;
  /** 批准的时刻（毫秒） */
  at: number;
}

/** 存盘的形状 */
interface GrantsFile {
  cards: Record<string, CardGrant[]>;
}

/** 授权账（每张卡一份） */
export class GrantStore {
  private readonly cards = new Map<string, CardGrant[]>();

  constructor(private readonly filePath: string) {
    this.load();
  }

  /** 这张卡被批准了哪些动作 */
  forCard(cardId: string): CardGrant[] {
    return this.cards.get(cardId) ?? [];
  }

  /** 批准过的动作 id（给 `effectiveWrite` 用） */
  actionIds(cardId: string): string[] {
    return this.forCard(cardId).map((grant) => grant.actionId);
  }

  /** 记一笔批准（**幂等**：同一个动作再批准一次只是刷新时间） */
  grant(cardId: string, actionId: string, domains?: Record<string, PackGuard>, at = Date.now()): void {
    const list = this.cards.get(cardId) ?? [];
    const existing = list.findIndex((g) => g.actionId === actionId);
    const grant: CardGrant = { actionId, at, ...(domains === undefined ? {} : { domains }) };
    if (existing >= 0) list[existing] = grant;
    else list.push(grant);
    this.cards.set(cardId, list);
    this.save();
  }

  /** 收回一个动作的授权 */
  revoke(cardId: string, actionId: string): void {
    const list = this.cards.get(cardId);
    if (list === undefined) return;
    const left = list.filter((g) => g.actionId !== actionId);
    if (left.length === 0) this.cards.delete(cardId);
    else this.cards.set(cardId, left);
    this.save();
  }

  /** 读盘（读不出来就算没有授权——**默认是「没有」**） */
  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as GrantsFile;
      for (const [cardId, grants] of Object.entries(parsed.cards ?? {})) {
        this.cards.set(cardId, grants);
      }
    } catch {
      // 读不出来就当没有授权（**默认拒绝**比默认放行安全）
      this.cards.clear();
    }
  }

  /** 存盘（每行 flush 的原子写：先写临时文件再改名） */
  private save(): void {
    const cards: Record<string, CardGrant[]> = {};
    for (const [cardId, grants] of this.cards) cards[cardId] = grants;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ cards }, null, 2), 'utf8');
    // 改名是原子的 → 断电不会留下半个文件
    renameSync(tmp, this.filePath);
  }
}

import { randomUUID } from 'node:crypto';
import type { CardManifest } from './manifest';
import type { CardIssue } from './validate';
import { listCardDirs, type CardRoot } from './roots';
import { cardRevision } from './revision';

/**
 * 卡片注册表：**装了什么卡**、每个实例的地址是多少。
 *
 * ── 「不合法就保留上一版」 ──
 *
 * agent 写卡写到一半，manifest 可能是坏的。
 * 这时候**不能把卡片从工作台上撤走**——它上一版还是好的，
 * 撤走 = 用户眼睁睁看着自己刚做的仪表消失。
 * → 保留上一版，把问题**记下来**显示出来（`issues`）。
 *
 * ── 实例是什么 ──
 *
 * 一个**实例 = 一张卡 + 一条连接**（契约 §7.8：连接上下文是隐式作用域）。
 * 同一张卡在两条连接上 → 两个实例 → 两个 iframe → 各自看各自的板子。
 */
export interface DiscoveredCard {
  cardId: string;
  dir: string;
  manifest: CardManifest;
  /** 这张卡的问题（`severity` 区分「不合法」与「未验证」） */
  issues: CardIssue[];
  rootKind: 'builtin' | 'user';
  /**
   * 卡片目录的**内容指纹**（变了 = 卡片代码变了）。
   *
   * 它进了实例 id → URL 变 → **iframe 重建** → 「改文件即热更新」才成立。
   */
  revision: string;
}

export interface CardRegistryDeps {
  roots: CardRoot[];
  /** 读并解析一个卡片目录的 manifest（**解析失败会抛**） */
  loadManifest: (dir: string) => CardManifest;
  /** 校验一个 manifest，返回问题清单 */
  validate: (manifest: CardManifest, dir: string) => CardIssue[];
}

export class CardRegistry {
  /** 每一张卡的当前状态 */
  private readonly byCard = new Map<string, DiscoveredCard>();
  /** `(卡片 id | 连接 id) → 实例 id`。**稳定**：同一对永远同一个实例 */
  private readonly instances = new Map<string, string>();
  /** 实例 id → 卡片 id（协议处理器靠它反查卡片目录） */
  private readonly instanceCards = new Map<string, string>();

  constructor(private readonly deps: CardRegistryDeps) {}

  /**
   * 重新扫一遍卡片目录。
   *
   * @returns 当前的卡片清单
   */
  refresh(): DiscoveredCard[] {
    const found = listCardDirs(this.deps.roots);
    const seen = new Set<string>();

    for (const entry of found) {
      seen.add(entry.cardId);
      let manifest: CardManifest;
      try {
        manifest = this.deps.loadManifest(entry.dir);
      } catch (err) {
        // **manifest 根本读不出来**（JSON 坏了 / 字段不认识）：
        // 同样「保留上一版」，把问题记下来。
        const issue: CardIssue = {
          severity: 'error',
          rule: 10,
          path: 'manifest.json',
          message: `manifest 读不出来：${err instanceof Error ? err.message : String(err)}`,
        };
        const previous = this.byCard.get(entry.cardId);
        if (previous !== undefined) {
          this.byCard.set(entry.cardId, { ...previous, issues: [issue] });
        }
        continue;
      }

      const issues = this.deps.validate(manifest, entry.dir);
      const blocking = issues.filter((i) => i.severity === 'error');
      if (blocking.length > 0) {
        // **不合法 → 保留上一版**（manifest 与 issues 都留痕）
        const previous = this.byCard.get(entry.cardId);
        if (previous !== undefined) {
          this.byCard.set(entry.cardId, { ...previous, issues });
        } else {
          // 第一次就装上就坏了 → 这张卡**不进工作台**，
          // 但问题得有地方说（诊断报告里能看到）
          this.byCard.set(entry.cardId, {
            cardId: entry.cardId,
            dir: entry.dir,
            manifest,
            issues,
            rootKind: entry.rootKind,
            revision: cardRevision(entry.dir),
          });
        }
        continue;
      }

      this.byCard.set(entry.cardId, {
        cardId: entry.cardId,
        dir: entry.dir,
        manifest,
        issues,
        rootKind: entry.rootKind,
        // **内容变了 → 指纹变了 → 实例 id 变了 → iframe 会重建**
        revision: cardRevision(entry.dir),
      });
    }

    // 目录里没了的卡 → 从清单里撤掉（文件被删了）
    for (const cardId of [...this.byCard.keys()]) {
      if (!seen.has(cardId)) this.byCard.delete(cardId);
    }

    return this.cards();
  }

  /** 当前卡片清单 */
  cards(): DiscoveredCard[] {
    return [...this.byCard.values()].sort((a, b) => a.cardId.localeCompare(b.cardId));
  }

  /** 一张卡的目录。**没装就是 null**（不猜） */
  dirOf(cardId: string): string | null {
    return this.byCard.get(cardId)?.dir ?? null;
  }

  /**
   * 取（或分配）一个实例。
   *
   * ── 实例键里**有内容指纹** ──
   *
   * 实例 id 进了 iframe 的 URL；**URL 不变，浏览器就不重新加载**——
   * 卡片里跑的会一直是旧代码。所以「卡片内容变了」必须体现在实例 id 上：
   * 指纹变 → 键变 → **新实例 id** → URL 变 → React 的 key 变 → iframe 重建 ✓
   * （旧会话随之被关掉，订阅不泄漏——见 `wiring.ts` 的 `list()`）
   *
   * @param connectionId 这张卡看的是哪条连接。`null` = 还没有连接上下文
   */
  instanceFor(cardId: string, connectionId: string | null): { instanceId: string; url: string } {
    const revision = this.byCard.get(cardId)?.revision ?? '';
    const key = `${cardId} ${connectionId ?? ''} ${revision}`;
    let instanceId = this.instances.get(key);
    if (instanceId === undefined) {
      instanceId = randomUUID();
      this.instances.set(key, instanceId);
    }
    this.instanceCards.set(instanceId, cardId);
    const card = this.byCard.get(cardId);
    const entry = card?.manifest.entry ?? 'index.html';
    return { instanceId, url: `cockpit://card/${instanceId}/${entry}` };
  }

  /** 这个实例是哪张卡（**没登记过就是 null**） */
  cardOfInstance(instanceId: string): string | null {
    return this.instanceCards.get(instanceId) ?? null;
  }

  /** 这个实例的卡片目录（协议处理器靠它伺服资源） */
  dirOfInstance(instanceId: string): string | null {
    const cardId = this.cardOfInstance(instanceId);
    if (cardId === null) return null;
    return this.byCard.get(cardId)?.dir ?? null;
  }

  /** 这个实例的入口文件（相对卡片目录） */
  entryOfInstance(instanceId: string): string | null {
    const cardId = this.cardOfInstance(instanceId);
    if (cardId === null) return null;
    return this.byCard.get(cardId)?.manifest.entry ?? null;
  }
}

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 卡片目录的两个根。
 *
 * | 根 | 在哪 | 谁放 |
 *---|---|---|
 * `builtin` | 应用目录下的 `cards/` | 产品自带（目标切换器之类） |
 * `user` | 用户数据目录下的 `cards/` | **人**与 agent |
 *
 * ── 「用户优先」是「卡片即文件」的前提 ──
 *
 * 人（或 agent）改一张内置卡 = 在用户目录里放一个**同 id** 的目录。
 * **用户目录赢**——否则「改文件即生效」这句话对内置卡就是假的。
 */
export interface CardRoot {
  dir: string;
  kind: 'builtin' | 'user';
}

/**
 * 找一张卡的目录。
 *
 * @returns 找不到是 `null`（**不猜**——契约的「不猜」口径）
 */
export function findCardDir(roots: CardRoot[], cardId: string): string | null {
  // **用户根优先**：roots 的顺序不决定优先级，kind 决定
  const ordered = [...roots].sort((a, b) => (a.kind === 'user' ? -1 : 1) - (b.kind === 'user' ? -1 : 1));
  for (const root of ordered) {
    const dir = join(root.dir, cardId);
    if (existsSync(join(dir, 'manifest.json'))) return dir;
  }
  return null;
}

/**
 * 列出所有卡（目录里有 `manifest.json` 的才算）。
 *
 * 同 id 的按**用户根赢**——一份清单里**一张卡只有一个目录**，
 * 不然协议处理器该伺服哪一个就成了猜。
 */
export function listCardDirs(
  roots: CardRoot[],
): { cardId: string; dir: string; rootKind: 'builtin' | 'user' }[] {
  const found = new Map<string, { cardId: string; dir: string; rootKind: 'builtin' | 'user' }>();
  // **先用户根**，这样后面遇到同 id 的内置卡**不覆盖**它
  const ordered = [...roots].sort((a, b) => (a.kind === 'user' ? -1 : 1) - (b.kind === 'user' ? -1 : 1));
  for (const root of ordered) {
    if (!existsSync(root.dir)) continue;
    for (const entry of readdirSync(root.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root.dir, entry.name);
      if (!existsSync(join(dir, 'manifest.json'))) continue;
      if (!found.has(entry.name)) {
        found.set(entry.name, { cardId: entry.name, dir, rootKind: root.kind });
      }
    }
  }
  return [...found.values()].sort((a, b) => a.cardId.localeCompare(b.cardId));
}

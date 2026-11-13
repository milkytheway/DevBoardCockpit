import { describe, it, expect } from 'vitest';
import { relative, isAbsolute } from 'node:path';
import { cardRootsDir, cardStorageDir } from '../../src/main/util/paths';

/**
 * 卡片相关目录的**位置约定**。
 *
 * ── 一条不能破的规矩 ──
 *
 * **存储目录不能落在卡片根目录里面。**
 *
 * 卡片根目录是被 `fs.watch` 盯着的（热插拔：「改文件即生效」）。
 * 存储写在根目录里的话：
 *
 * ```
 * 卡片写一次 storage  →  落盘 storage.json  →  fs.watch 触发
 *                     →  refresh() + broadcast(cardsChanged)
 *                     →  页面重取清单  →  卡片再写一次  →  …
 * ```
 *
 * → **回路**。一张爱存盘的卡就能把它点着（CPU 空转、IPC 刷屏）。
 *
 * 所以存储放在**兄弟目录**：`cards/` 与 `card-storage/` 各管各的。
 */
describe('卡片目录的位置', () => {
  it('**存储目录不在卡片根目录里**（否则写一次存储就触发一次热刷新）', () => {
    const roots = cardRootsDir('DevBoardCockpit-test');
    const storage = cardStorageDir('DevBoardCockpit-test');
    const rel = relative(roots, storage);
    // 相对路径不以 `..` 开头 = **在根目录之外**
    expect(rel.startsWith('..')).toBe(true);
    expect(isAbsolute(rel)).toBe(false);
  });

  it('两个目录都在用户数据目录下', () => {
    expect(cardRootsDir('X').includes('X')).toBe(true);
    expect(cardStorageDir('X').includes('X')).toBe(true);
  });

  it('两个目录**不是同一个**', () => {
    expect(cardRootsDir('X')).not.toBe(cardStorageDir('X'));
  });
});

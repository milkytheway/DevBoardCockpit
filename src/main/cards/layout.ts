import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 布局的**落盘**（core 轨的部分）。
 *
 * ── 它是什么 ──
 *
 * 「哪张卡在哪个格子里」是**宿主的账**：
 * 契约 §七说「绑定发生处：**布局层**：布局单元记录 `(cardId, connectionId)`」。
 * 卡片不知道自己在哪，页面也不该自己记（刷新就没了）。
 *
 * ── 键是 `(cardId, connectionId)` ──
 *
 * 契约 §7.8：一张卡可以在多条连接上各有一个实例 → 每个实例**各占一格**。
 * 所以只按 `cardId` 记会撞车（两张卡挤进同一格）。
 *
 * ── 一个布局（不再有视图）──
 *
 * v3 起布局就是一份（主区摆了哪些卡）。旧文件照样读得出来：
 * v1（`{units, updatedAt}`）直接用，v2（多视图）取**当前视图**那份。
 * 
 * ── 为什么落盘要「坏了也不抛」 ──
 *
 * 布局文件在用户目录里，可能被写了一半、被人手改坏。
 * **一个文件坏了不该让应用起不来**——那等于用户的布局问题变成了应用的问题。
 * → 读不出来就当空布局（用户重新摆一次），并把坏文件原样留着（不覆盖它，
 * 免得把用户的现场毁掉）。
 */

// **形状住在 `shared/`**（它要过 IPC）——这里再导出一次，调用方不用改 import
export type { LayoutUnit, LayoutState } from '../../shared/layout';

import { normalizeLayout } from '../../shared/layout';
import type { LayoutState, LayoutStateInput } from '../../shared/layout';

export class LayoutStore {
  constructor(private readonly deps: { file: string; now: () => number }) {}

  /** 读布局。**读不出来就是空布局**（不抛；v1/v2 旧文件都读得出来） */
  get(): LayoutState {
    const now = this.deps.now();
    if (!existsSync(this.deps.file)) return normalizeLayout(undefined, now);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.deps.file, 'utf8'));
    } catch {
      // **文件坏了 → 当空的**（不是崩溃的理由）
      return normalizeLayout(undefined, now);
    }
    return normalizeLayout(parsed, now);
  }

  /** 存布局（**原子写**：先写临时文件再改名——免得写一半断电） */
  set(state: LayoutStateInput): void {
    state = normalizeLayout(state, this.deps.now());
    const file = this.deps.file;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    // **改名是原子的**（同一个文件系统内）
    renameSync(tmp, file);
  }
}

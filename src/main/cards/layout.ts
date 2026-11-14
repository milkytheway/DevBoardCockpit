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
 * ── 为什么落盘要「坏了也不抛」 ──
 *
 * 布局文件在用户目录里，可能被写了一半、被人手改坏。
 * **一个文件坏了不该让应用起不来**——那等于用户的布局问题变成了应用的问题。
 * → 读不出来就当空布局（用户重新摆一次），并把坏文件原样留着（不覆盖它，
 * 免得把用户的现场毁掉）。
 */

// **形状住在 `shared/`**（它要过 IPC）——这里再导出一次，调用方不用改 import
export type { LayoutUnit, LayoutState } from '../../shared/layout';

import type { LayoutState, LayoutUnit } from '../../shared/layout';

/** 默认格：3×2（契约 §2.4 的默认） */
const DEFAULT_W = 3;
const DEFAULT_H = 2;

export class LayoutStore {
  constructor(private readonly deps: { file: string; now: () => number }) {}

  /** 读布局。**读不出来就是空布局**（不抛） */
  get(): LayoutState {
    if (!existsSync(this.deps.file)) return { units: [], updatedAt: 0 };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.deps.file, 'utf8'));
    } catch {
      // **文件坏了 → 当空的**（不是崩溃的理由）
      return { units: [], updatedAt: 0 };
    }
    if (parsed === null || typeof parsed !== 'object') return { units: [], updatedAt: 0 };
    const raw = (parsed as { units?: unknown }).units;
    if (!Array.isArray(raw)) return { units: [], updatedAt: 0 };
    const units = raw.filter(isLayoutUnit);
    const updatedAt = (parsed as { updatedAt?: unknown }).updatedAt;
    return {
      units,
      updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
    };
  }

  /** 存布局（**原子写**：先写临时文件再改名——免得写一半断电） */
  set(state: LayoutState): void {
    const file = this.deps.file;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    // **改名是原子的**（同一个文件系统内）
    renameSync(tmp, file);
  }

  /**
   * 一张卡的默认格子。
   *
   * @param layout manifest 里声明的尺寸（缺省 3×2）
   */
  defaultFor(
    cardId: string,
    connectionId: string | null,
    layout?: { w?: number; h?: number },
  ): LayoutUnit {
    return {
      cardId,
      connectionId,
      x: 0,
      y: 0,
      w: layout?.w ?? DEFAULT_W,
      h: layout?.h ?? DEFAULT_H,
    };
  }
}

/** 一格是不是**形状对**的单元（布局文件是用户能碰的 → 进来之前要收形状） */
function isLayoutUnit(raw: unknown): raw is LayoutUnit {
  if (raw === null || typeof raw !== 'object') return false;
  const u = raw as Record<string, unknown>;
  if (typeof u['cardId'] !== 'string') return false;
  const num = (key: string): boolean => typeof u[key] === 'number' && Number.isFinite(u[key]);
  return num('x') && num('y') && num('w') && num('h');
}

import { statSync } from 'node:fs';
import { matchTagPattern } from '../tags/vocabulary';
import type { TagReading } from '../../shared/tag-reading';
import type { CardManifest } from './manifest';
import type { PackView } from '../tags/pack-view';

/**
 * **卡片在当前板上的状态**（契约 `spec/04` §2.2 ✓ · ADR-D40 ✓）。
 *
 * ── 「读不到」与「不存在」是两件事 ──
 *
 * | 字段 | 问的是 |
 * |---|---|
 * | `missing_tags` | **当前板型包根本没有**这个 tag ✓（**模式级** ✓） |
 * | `unreadable_tags` | 包**有**，但**现在读不出来** ✓（**具体名级** ✓） |
 *
 * → **混成一个字段的后果** ✓：
 * 「整个 `cpu` reader 挂了 → 通配实例在读数里**不会变 stale** ✓
 *   → 读数里还是 `ok` + 旧值 ✓ → 卡片**不会被判 degraded** ✓ → **agent 被骗** ✓」。
 *
 * → 所以**必须分开** ✓。
 *
 * ── 「通配实例在读数里缺席 ≠ 缺失」 ──
 *
 * 采样器**按契约不猜具体实例名** ✓（`cpu.core.*.usage` 的具体核数只有板子知道 ✓）
 * → 失败时**不知道该标哪个具体 tag** ✓ → 跳过 ✓
 * → **所以读数里没有它，不能据此判「缺失」** ✓。
 */

/** 一张卡在当前板上的状态（**给 agent 看的那份** ✓） */
export interface CardState {
  /** **卡片 id = 卡片目录名** ✓（宿主侧一切按它索引 ✓） */
  id: string;
  /** manifest 里声明的 id（**可以与目录名不同** ✓ → 所以是两个字段 ✓） */
  manifest_id: string;
  name: string;
  version: string;
  /** 卡片目录的**绝对路径** ✓ */
  path: string;
  /**
   * **卡片目录的最后修改时刻**（毫秒 UTC）✓。
   *
   * → **不是「人点装上的时刻」** ✓ —— 宿主**从没记过安装时间** ✓。
   * → **明写它是什么** ✓ —— 否则 agent 会拿它排序「最近装的卡」✗（那会错）✗。
   */
  installed_at: number;
  /** `ok` / `degraded` / `invalid`（封闭 ✓） */
  status: 'ok' | 'degraded' | 'invalid';
  /** 这张卡在当前板上**是不是残的** ✓ */
  degraded: boolean;
  /** 要读、**当前板型包根本没有**的 tag（**模式级** ✓） */
  missing_tags: string[];
  /** 声明了、包也提供了、但**现在读不出来**的 tag（**具体名级** ✓） */
  unreadable_tags: string[];
}

/** 算卡片状态要的东西 */
export interface CardStateInput {
  /** 宿主注册表里的那张卡（**目录名是 id** ✓） */
  cardId: string;
  dir: string;
  manifest: CardManifest;
  /** 这张卡的问题（**错误级 = manifest 不合法** ✓） */
  issues: { severity: 'error' | 'warning' }[];
  /** 当前的板型包视图（**没有就是 `null`** ✓ —— 那就没有「板上根本没有」这回事 ✓） */
  pack: PackView | null;
  /** 当前读数（**只判具体名** ✓） */
  readings: TagReading[];
}

/**
 * **模式级判据**：这个模式 `P` 有没有被当前包提供 ✓。
 *
 * → **判的是「有没有一个包的 provides 模式覆盖 P」** ✓ —— 不是「读数里有没有」✓
 *   （读数里有没有是**读不出来**那一档 ✓ —— 两个口径不能混 ✓）。
 *
 * → **覆盖的判定**：段数相同 ✓ 且**逐段**：
 * - 两段都是字面 → 必须相等 ✓
 * - 一段是通配 → **覆盖** ✓（`cpu.*.usage` 覆盖 `cpu.core.usage` ✓）
 * - 两段都是字面但不等 → 不覆盖 ✓
 *
 * → **注意方向** ✓：`cpu.core.*.usage` **不**覆盖 `cpu.usage` ✓（段数不同 ✓）。
 */
export function patternCovered(provided: string, wanted: string): boolean {
  const ps = provided.split('.');
  const ws = wanted.split('.');
  if (ps.length !== ws.length) return false;
  for (let i = 0; i < ps.length; i += 1) {
    const p = ps[i] as string;
    const w = ws[i] as string;
    if (p === '*' || w === '*') continue;
    if (p !== w) return false;
  }
  return true;
}

/** 一个模式有没有被当前包提供 ✓ */
function isProvided(pack: PackView | null, wanted: string): boolean {
  if (pack === null) return true; // **没有包 → 不判「板上根本没有」** ✓
  for (const reader of pack.readers) {
    for (const tag of reader.provides) {
      if (patternCovered(tag, wanted)) return true;
    }
  }
  return false;
}

/**
 * **这张卡要的、板上根本没有的 tag**（**模式级** ✓）。
 *
 * → **记模式本身** ✓ —— **不展开成具体名** ✓
 *   （宿主侧**没有「模式 → 具体名」的函数** ✓ —— 只有反方向 ✓ —— 不猜 ✓）。
 */
export function missingTags(manifest: CardManifest, pack: PackView | null): string[] {
  const out: string[] = [];
  for (const pattern of manifest.permissions.read) {
    if (!isProvided(pack, pattern)) out.push(pattern);
  }
  return out;
}

/**
 * **声明了、包也提供了、但现在读不出来的 tag**（**具体名级** ✓）。
 *
 * → **只列读数里有的那些** ✓ —— 通配实例在读数里**缺席**时**不列** ✓
 *   （那是「板上就没有 / 还没采到」✓ —— 不是「读不到」✓）。
 * → 判据：**该具体名在读数里** ✓ 且**状态不是 `ok`** ✓。
 */
export function unreadableTags(
  manifest: CardManifest,
  _pack: PackView | null,
  readings: TagReading[],
): string[] {
  const out: string[] = [];
  for (const reading of readings) {
    if (reading.status === 'ok') continue;
    // **这张卡要读它吗** ✓ —— 按模式覆盖判 ✓
    const wanted = manifest.permissions.read.some((p) => matchTagPattern(p, reading.tag));
    if (!wanted) continue;
    out.push(reading.tag);
  }
  return out;
}

/**
 * **算一张卡在当前板上的状态** ✓。
 *
 * → **`status` 的三档** ✓：
 * | 值 | 什么时候 |
 * |---|---|
 * | `invalid` | **manifest 本身不合法** ✓（有错误级问题 ✓） |
 * | `degraded` | manifest 合法 ✓ **但**有 tag 读不到 ✓（或有警告 ✓） |
 * | `ok` | 干净 ✓ |
 *
 * → **`invalid` 的卡仍然列出来** ✓ —— agent 要知道「我上次装的那张卡坏了」✓。
 */
export function cardState(input: CardStateInput): CardState {
  const hasError = input.issues.some((i) => i.severity === 'error');
  const hasWarning = input.issues.some((i) => i.severity === 'warning');

  const missing = missingTags(input.manifest, input.pack);
  const unreadable = unreadableTags(input.manifest, input.pack, input.readings);
  const degraded = missing.length > 0 || unreadable.length > 0;

  const status: CardState['status'] = hasError ? 'invalid' : degraded || hasWarning ? 'degraded' : 'ok';

  return {
    id: input.cardId,
    manifest_id: input.manifest.id,
    name: input.manifest.name,
    version: input.manifest.version,
    path: input.dir,
    installed_at: dirModifiedAt(input.dir),
    status,
    degraded,
    missing_tags: missing,
    unreadable_tags: unreadable,
  };
}

/**
 * **卡片目录的最后修改时刻**（毫秒 UTC）✓。
 *
 * → **拿不到就是 `0`** ✓（不猜 ✓ —— 目录被删了 ✓ / 权限不够 ✓）。
 */
export function dirModifiedAt(dir: string): number {
  try {
    return Math.trunc(statSync(dir).mtimeMs);
  } catch {
    return 0;
  }
}

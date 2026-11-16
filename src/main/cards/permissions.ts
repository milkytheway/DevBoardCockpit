import { matchTagPattern } from '../tags/vocabulary';

/**
 * 卡片的权限集（契约 `spec/03` §2）。
 *
 * ── 一句话 ──
 *
 * > `requires` 里的每一项，必须被 `permissions` 里的**某一项**覆盖。
 *
 * **注意是「覆盖」不是「相等」**——这让卡片既能声明精确需求，
 * 又能申请一个更宽的读权限（反过来不成立）。
 *
 * **为什么读权限用模式、写权限不用**（契约 §2.3）：
 * 读一个 `cpu.usage` 没有副作用；写一个动作会改板子。
 * 模式让授权范围变大，对读来说方便，对写来说**危险**。
 */
export interface CardPermissions {
  read: string[];
  write: string[];
  /** 允许这张卡触发的**流程 id**（第二个授权维度 ✓ —— 评审 37 的 V3-I9 ✓） */
  workflows?: string[];
}

/**
 * 这个 tag 被读权限覆盖了吗？
 *
 * 实现就是 `perms.read.some((p) => matchTagPattern(p, tag))`——
 * **复用词表层那一个匹配器**，不自己写第二套规则
 * （第二套规则迟早和第一套对不上）。
 */
export function permissionCovers(perms: CardPermissions, tag: string): boolean {
  return perms.read.some((pattern) => matchTagPattern(pattern, tag));
}

/**
 * `requires` 的每一项都被读权限覆盖了吗？（契约 §2.2 的布尔形式）
 *
 * **M5 的校验器不用它**——规则 3 是**逐项报**的（告诉人「是哪一条没被覆盖」），
 * 比一个布尔值有用。M6 的授权检查用它。
 */
export function requiresSatisfied(requires: string[], perms: CardPermissions): boolean {
  return requires.every((tag) => permissionCovers(perms, tag));
}

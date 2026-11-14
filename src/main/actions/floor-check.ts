import { matchDangerFloorArgv, tokenizeCommand, type FloorMatch } from '../tags/floor';

/**
 * 危险地板的**运行时复查** —— 契约 `docs/spec/02-board-pack.md` §5.2.1。
 *
 * ── 它与校验器的那次复查差在哪 ──
 *
 * | | 查的对象 | 什么时候 |
 * |---|---|---|
 * | 校验器（规则 16） | **命令模板** | 装包时 |
 * | **这里** | **编码后的最终命令** | 每次执行前 |
 *
 * 差别就是**参数值**：模板 `rm -rf {dir}` 干干净净，
 * 而 `dir` 的值是 `/` 时，最终命令就是 `rm -rf /`。
 * → **危险动作只在模板里查是不够的**（§5.3 说过这件事）。
 *
 * ── 处置 ──
 *
 * **命中 → 按 `destructive` 处理**（走确认通道，不是直接拒绝）——
 * §5.2.1：「运行时在执行一个动作前，把命令和地板表对一遍。
 * 命中任何一条，这个动作按 destructive 处理」。
 *
 * **没命中 ≠ 安全**（§5.2）：表里没有的模式按包的声明走，
 * 但**必须记一条 warning**。
 */
export interface FloorVerdict extends FloorMatch {
  /** 命中 → 按 `destructive` 处理；没命中 → `ok` */
  verdict: 'ok' | 'destructive';
  /** 没命中时的告警（**匹配不上不等于安全**） */
  warning: string | null;
}

/**
 * 拿 **argv** 撞地板。
 *
 * **不重新切词** —— 传进来的就是 shell 会看到的那些词
 * （切词的是 `tokenizeCommand`，编码器与这里共用它）。
 */
export function checkFloorArgv(argv: string[]): FloorVerdict {
  const match = matchDangerFloorArgv(argv);
  if (match.matched) {
    return { ...match, verdict: 'destructive', warning: null };
  }
  return {
    ...match,
    verdict: 'ok',
    warning:
      '命令没有命中危险地板的任何一条 —— **匹配不上不等于安全**：' +
      '表里没有的模式按包的声明走，但这条要记进审计',
  };
}

/**
 * 拿一条**最终命令**（编码后）撞地板。
 *
 * @param command 编码后的命令（`actions/encoder` 的产物）。
 */
export function checkFloor(command: string): FloorVerdict {
  return checkFloorArgv(tokenizeCommand(command));
}

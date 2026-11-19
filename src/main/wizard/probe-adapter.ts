import type { ProbeReaderReport } from '../tags/probe';
import type { ProbeOutcome } from './instantiate';

/**
 * **探针报告 → 实例化的输入** ✓ —— 2026-11-19 加 ✓。
 *
 * ── 为什么要有这一层（**形状不一样** ✓）──
 *
 * → **探针的报告** ✓：`ProbeReaderReport` ✓ —— 它有 `readerId` ✓ · `ok` ✓ ·
 *   `problems`（为什么红 ✓）· `tags`（产出了什么 ✓）。
 * → **实例化要的** ✓：`ProbeOutcome` ✓ —— 它要 `readerId` ✓ · `ok` ✓ ·
 *   `detail`（**一句话** ✓）· `tags`。
 * → **两边的 `detail` 语义不同** ⚠️ —— 探针给的是**一组问题** ✓，
 *   实例化要的是**一句话** ✓ → **所以要在这里合成** ✓。
 *
 * → **为什么不直接把 `ProbeOutcome` 写成探针的形状** ⚠️
 *   → **实例化不该依赖探针** ✓（它是一个纯函数 ✓ —— **不碰探针** ✓）
 *   → **而且**探针的形状**将来会变** ✓（`problems` 可能改名 ✓）→
 *   → **实例化不该跟着变** ✓ → **中间这一层就是隔离带** ✓。
 */

/** 探针的问题列表 → **一句话** ✓ */
function detailOf(report: ProbeReaderReport): string {
  if (report.problems.length === 0) return '';
  if (report.problems.length === 1) return report.problems[0] ?? '';
  return `${report.problems.length} 个问题：${report.problems.join('；')}`;
}

/**
 * **一份探针报告 → 实例化的输入** ✓。
 *
 * → **只取 reader 级别的绿/红** ✓ —— **值不参与** ✓
 *   （**实例化只问「有没有」✓ —— 不问「是多少」✓** → **值是运行时的事** ✓）。
 */
export function outcomesOf(reports: readonly ProbeReaderReport[]): ProbeOutcome[] {
  return reports.map((report) => ({
    readerId: report.readerId,
    ok: report.ok,
    detail: detailOf(report),
    tags: report.tags.map((t) => ({ tag: t.tag, value: t.value })),
  }));
}

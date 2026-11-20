import type { ProbeReaderReport } from '../tags/probe';
import type { ProbeOutcome } from './instantiate';

/**
 * The report of the probe → the input of the instantiation — added
 * 2026-11-19.
 *
 * ── Why this layer exists (the shapes differ ✓) ──
 *
 * → The report of the probe ✓: `ProbeReaderReport` ✓ — it has
 *   `readerId` ✓ · `ok` ✓ · `problems` (why it is red ✓) · `tags` (what it
 *   produced ✓).
 * → What the instantiation wants ✓: `ProbeOutcome` ✓ — it wants
 *   `readerId` ✓ · `ok` ✓ · `detail` (one sentence ✓) · `tags`.
 * → The two `detail` mean different things ⚠️ — the probe gives a
 *   set of problems ✓, the instantiation wants one sentence ✓ →
 *   so they are combined here ✓.
 *
 * → Why `ProbeOutcome` is not simply written in the shape of the probe
 *   ⚠️
 *   → The instantiation must not depend on the probe ✓ (it is a pure
 *     function ✓ — it does not touch the probe ✓)
 *   → and the shape of the probe will change ✓ (`problems` may be
 *     renamed ✓) →
 *   → The instantiation must not change with it ✓ → this layer in
 *     between is the isolation ✓.
 */

/** The list of problems of the probe → one sentence ✓ */
function detailOf(report: ProbeReaderReport): string {
  if (report.problems.length === 0) return '';
  if (report.problems.length === 1) return report.problems[0] ?? '';
  return `${report.problems.length} problems: ${report.problems.join('; ')}`;
}

/**
 * One report of the probe → the input of the instantiation ✓.
 *
 * → Only the green/red of the reader level ✓ — the value does not
 *   take part ✓
 *   (the instantiation only asks "is it there" ✓ — not "how much" ✓ →
 *   the value is a matter of the runtime ✓).
 */

export function outcomesOf(reports: readonly ProbeReaderReport[]): ProbeOutcome[] {
  return reports.map((report) => ({
    readerId: report.readerId,
    ok: report.ok,
    detail: detailOf(report),
    tags: report.tags.map((t) => ({ tag: t.tag, value: t.value })),
  }));
}

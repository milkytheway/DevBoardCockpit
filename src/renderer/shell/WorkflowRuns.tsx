import { useEffect, useState } from 'react';
import type { HostWorkflowRun } from '../../shared/ipc-contract';
import { interpolate, pick, useLocale, useT, type Locale, type Localised } from './i18n';

/**
 * **The running workflows** (contract `05` §8.A ✓) — **the only place the
 * host offers a "stop"** ✓.
 *
 * ── Why it lives in the **host** and not in a card ──
 *
 * Contract **A4** ✓: **only the host can cancel** ✓ (**neither the cards nor
 * an agent have that interface** ✓) →
 * → "stop somebody else's run" is **not covered by any permission** ✓ →
 *   **the button does not belong in a card** ✓
 * → **So it has to live outside the cards** ✓ (a card is a sandbox ✓ and
 *   cannot reach the host chrome ✓).
 *
 * ── Why it lives in the **title bar** (`.window-drag`) and not in the page
 * header ──
 *
 * → **A build takes minutes** ✓ (measured 58.9 s / 98.5 s ✓) → the user is
 *   **likely to switch to the terminal page** in the meantime ✓
 * → The page header **moves with the page** ✗ → once the user has left, the
 *   **"stop" is nowhere to be found** ✗
 * → The title bar **stays** ✓ (next to the board selector ✓ — "the board I am
 *   on, and what is running on it" ✓).
 *
 * ── What it shows (**restrained** ✓) ──
 *
 * → **It appears only while something runs** ✓ (no permanent row ✓ — the
 *   title bar must not get crowded ✓)
 * → **The workflow name, the current step and the elapsed time** ✓
 * → **No percentage** ✓ (contract **B2** ✓ — the percentage of a transfer is
 *   a guess ✗; "it has been 42 seconds" is a fact ✓)
 * → One "stop" button ✓ (**one only** ✓ — several runs give several chips ✓
 *   but each of them still has a single button ✓).
 */

/** The wording of the strip, in both languages. */
const strings = {
  finishing: { 'zh-Hans': '收尾', en: 'Finishing' },
  stop: { 'zh-Hans': '停', en: 'Stop' },
  stopTitle: {
    'zh-Hans': '停掉这次运行（不承诺进程一定死 —— 那取决于传输）',
    en: 'Stop this run (the process is not guaranteed to die — that depends on the transport)',
  },
  elapsedSeconds: { 'zh-Hans': '{seconds} 秒', en: '{seconds} s' },
  elapsedMinutes: { 'zh-Hans': '{minutes} 分 {seconds} 秒', en: '{minutes} min {seconds} s' },
} satisfies Record<string, Localised>;
export function WorkflowRuns(): JSX.Element | null {
  const [runs, setRuns] = useState<HostWorkflowRun[]>([]);
  const [, forceTick] = useState(0);
  const t = useT();
  const locale = useLocale();

  useEffect(() => {
    const api = window.cockpit;
    if (!api) return undefined;
    let disposed = false;
    const pull = (): void => {
      void api
        .workflowsRecent()
        .then((list) => {
          if (!disposed) setRuns(list);
        })
        .catch(() => undefined);
    };
    pull();
    // **Once a second** ✓ — **how long it has been running** has to keep moving ✓ (contract B2 ✓)
    const timer = window.setInterval(pull, 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  // **Repaint once a second** — **how long it has been running** is **computed** ✓ (not polled ✓)
  useEffect(() => {
    const timer = window.setInterval(() => forceTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const running = runs.filter((r) => r.state === 'running');
  if (running.length === 0) return null;

  return (
    <div className="runs" data-testid="workflow-runs">
      {running.map((run) => (
        <div className="runs__chip" key={run.runId}>
          <span className="runs__dot" aria-hidden />
          <span className="runs__name">{run.workflowId}</span>
          <span className="runs__step">
            {run.current === null ? t(strings.finishing) : run.current.stepId}
            {run.current === null ? '' : ` · ${elapsed(run.current.at, locale)}`}
          </span>
          <button
            type="button"
            className="runs__stop"
            onClick={() => {
              void window.cockpit?.workflowsCancel(run.runId).catch(() => undefined);
            }}
            title={t(strings.stopTitle)}
          >
            {t(strings.stop)}
          </button>
        </div>
      ))}
    </div>
  );
}

/** "How long it has been running" — **computed** ✓ (contract B2 ✓: no percentage ✓) */
function elapsed(since: number, locale: Locale): string {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  if (seconds < 60) return interpolate(pick(strings.elapsedSeconds, locale), { seconds });
  const minutes = Math.floor(seconds / 60);
  return interpolate(pick(strings.elapsedMinutes, locale), {
    minutes,
    seconds: seconds % 60,
  });
}
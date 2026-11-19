import { useEffect, useState } from 'react';
import type { HostWorkflowRun } from '../../shared/ipc-contract';
import { interpolate, pick, useLocale, useT, type Locale, type Localised } from './i18n';

/**
 * **运行中的流程**（契约 `05` §八·A ✓）—— **宿主侧唯一的「停」入口** ✓。
 *
 * ── 为什么它在**宿主**而不在卡片里 ──
 *
 * 契约 **A4** ✓：**只有宿主能取消** ✓（**卡片与 agent 都没有这个接口** ✓）→
 * → 「停一次别人的运行」**不在任何权限项里** ✓ → **卡片里不该有这个按钮** ✓
 * → **所以它必须在卡片之外** ✓（卡片是沙箱 ✓ · 它碰不到宿主的 chrome ✓）
 *
 * ── 为什么它在**顶条**（`.window-drag`）而不是页面头 ──
 *
 * → **编译要几分钟** ✓（实测 58.9s / 98.5s ✓）→ 中途**很可能切到终端页** ✓
 * → 页面头**跟着页面换位置** ✗ → 切走了就**找不着那个「停」**了 ✗
 * → 顶条**一直在** ✓（跟「选板子」并排 ✓ —— 「我在这块板上 · 现在在跑什么」✓）
 *
 * ── 它显示什么（**克制** ✓）──
 *
 * → **只在有东西在跑时出现** ✓（没有常驻的行 ✓ —— 顶条不能变挤 ✓）
 * → **流程名 + 当前这一步 + 已经跑了多久** ✓
 * → **不给百分比** ✓（契约 **B2** ✓ —— 传输的百分比是猜的 ✗；「已经 42 秒」是事实 ✓）
 * → 一个「停」按钮 ✓（**就一个** ✓ —— 多个运行就多个 chip ✓ 但每个只一个按钮 ✓）
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
    // **一秒一次** ✓ —— 「已经跑了多久」要跟着走 ✓（契约 B2 ✓）
    const timer = window.setInterval(pull, 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  // **每秒重画一次** —— 「已经跑了多久」是**算出来的** ✓（不是轮询来的 ✓）
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

/** 「已经跑了多久」—— **算出来的** ✓（契约 B2 ✓：不给百分比 ✓） */
function elapsed(since: number, locale: Locale): string {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  if (seconds < 60) return interpolate(pick(strings.elapsedSeconds, locale), { seconds });
  const minutes = Math.floor(seconds / 60);
  return interpolate(pick(strings.elapsedMinutes, locale), {
    minutes,
    seconds: seconds % 60,
  });
}
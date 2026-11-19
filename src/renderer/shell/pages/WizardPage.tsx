import { useEffect, useRef, useState } from 'react';
import type { WizardRunResult } from '../../../shared/ipc-contract';
import { AlertIcon, CopyIcon, LinkIcon } from '../Icons';

/**
 * **接一块还不认识的板子**（人只做一步 ✓）。
 *
 * 人选通道、填串口和名字，然后一次调用跑完：
 * 建连接 → 试 13 个元操作 → 生成包 → 落盘。
 *
 * **界面不编进度** ✗ —— 宿主不回报中途状态；这里只说「正在做什么」，
 * 并明确告诉用户阶段是按耗时说的，不画百分比。
 */

type Transport = 'serial' | 'adb';
type Phase = 'form' | 'running' | 'done';

export interface WizardRequest {
  port: string;
  baudrate: number;
  boardName: string;
  transport?: Transport;
}

export interface WizardPageProps {
  /** Injected by the shell so the page stays testable without `window.cockpit`. */
  run: (input: WizardRequest) => Promise<WizardRunResult>;
  /** Called once after a pack lands, so the shell can refresh connections/cards. */
  onInstalled?: () => void;
}

const BAUD_RATES = [1500000, 115200, 921600, 460800, 230400, 57600, 9600] as const;

const STAGES = ['参数', '建立第一个真相', '试元操作', '生成包', '结果'] as const;

const WAIT_STEPS = [
  { index: 1, label: '建立第一个真相' },
  { index: 2, label: '试 13 个元操作' },
  { index: 3, label: '生成初版包' },
] as const;

const RESULT_TITLE: Record<WizardRunResult['kind'], string> = {
  ok: '这块板现在有自己的包了',
  'port-unopenable': '串口打不开',
  'no-reply': '板子没说话',
  'connection-dead': '那条连接一次都没通',
};

const FALLBACK_HINTS: Record<WizardRunResult['kind'], readonly string[]> = {
  ok: [],
  'port-unopenable': [
    '最常见的情况不是口选错，是有别的程序正独占着那个口（串口助手、终端、另一个 IDE）。',
    '关掉占用它的程序，或者把那个程序里的串口断开，再重新试一次。',
    '确认选的确实是板子的调试口，而不是另一个 USB 转串口。',
  ],
  'no-reply': [
    '先把波特率换成 1500000 —— 这块板要的就是这个速率，其他速率它不会回话。',
    '确认串口号是板子的调试口，不是普通 USB 口或另一个设备的串口。',
    '如果你刚打开过串口助手，先关掉它，确认回包没有被别的程序吃掉。',
    '板子要上电并停在 Linux 里；只插了 USB、系统没起来时，它不会说话。',
  ],
  'connection-dead': [
    '先查连接本身：线有没有插稳、板子有没有上电、串口号在设备管理器里还在不在。',
    '先别怀疑元操作 —— 一条命令都没跑通时，问题一定在更下面。',
    '换一条能确认可用的数据线，或者换一个 USB 口，再重新试一次。',
  ],
};

/** Strip the host's markdown-ish emphasis so the UI only shows plain text. */
function plain(text: string): string {
  return text
    .replace(/\*\*/g, '')
    .replace(/\s*✓\s*/g, ' ')
    .replace(/\s*⚠️?\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The host writes `标题 —— 细节`; the detail is what belongs under our headline. */
function detailOf(message: string): string {
  const cleaned = plain(message);
  const at = cleaned.indexOf('——');
  return (at >= 0 ? cleaned.slice(at + 3) : cleaned).trim();
}

function hintsFor(kind: WizardRunResult['kind'], hints: readonly string[]): string[] {
  const seen = new Set<string>();
  const merged = [...hints.map(plain), ...FALLBACK_HINTS[kind]];
  return merged.filter((hint) => {
    if (hint.length === 0 || seen.has(hint)) return false;
    seen.add(hint);
    return true;
  });
}

function failureStep(): number {
  // Every failure we can name happens while trying to get the first truth:
  // the port never opened, it opened but nothing came back, or the link died.
  return 1;
}

function waitDetail(elapsedMs: number): {
  index: number;
  title: string;
  detail: string;
} {
  // The first command has a 5s timeout in the host; after that the probes are
  // the long part. These are descriptions of the stage, not a progress bar.
  if (elapsedMs < 6_000) {
    return {
      index: 1,
      title: '建立第一个真相',
      detail: '打开串口，先让板子回一句话。它回了，这条路才算成立。',
    };
  }
  if (elapsedMs < 75_000) {
    return {
      index: 2,
      title: '试 13 个元操作',
      detail: '逐个确认这块板有没有这些能力。全部试完才会生成包。',
    };
  }
  return {
    index: 3,
    title: '生成初版包',
    detail: '绿的留下，红的删掉，然后把包和它的来路写进用户目录。',
  };
}

export function WizardPage({ run, onInstalled }: WizardPageProps): JSX.Element {
  const [transport, setTransport] = useState<Transport>('serial');
  const [port, setPort] = useState('');
  const [baud, setBaud] = useState('1500000');
  const [boardName, setBoardName] = useState('');
  const [phase, setPhase] = useState<Phase>('form');
  const [result, setResult] = useState<WizardRunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const startedAt = useRef(Date.now());
  const sequence = useRef(0);

  useEffect(() => {
    if (phase !== 'running') return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [phase]);

  const baudNumber = Number(baud);
  const baudOk = Number.isInteger(baudNumber) && baudNumber > 0;
  const portOk = transport === 'adb' || port.trim().length > 0;
  const canRun = boardName.trim().length > 0 && portOk && baudOk;
  const elapsedMs = Math.max(0, now - startedAt.current);
  const waiting = waitDetail(elapsedMs);

  const stageIndex =
    phase === 'form'
      ? 0
      : phase === 'running'
        ? waiting.index
        : result !== null && !result.ok
          ? failureStep()
          : 4;

  const railState = (index: number): 'done' | 'current' | 'failed' | 'pending' => {
    if (phase === 'form') return index === 0 ? 'current' : 'pending';
    if (phase === 'running') {
      return index < waiting.index ? 'done' : index === waiting.index ? 'current' : 'pending';
    }
    if (result?.ok) return 'done';
    if (index < stageIndex) return 'done';
    if (index === stageIndex) return 'failed';
    return 'pending';
  };

  const startRun = (): void => {
    if (!canRun || phase === 'running') return;
    const seq = sequence.current + 1;
    sequence.current = seq;
    startedAt.current = Date.now();
    setNow(startedAt.current);
    setPhase('running');
    setResult(null);
    setRunError(null);
    setCopyState('idle');

    const input: WizardRequest = {
      transport,
      port: transport === 'serial' ? port.trim() : '',
      baudrate: transport === 'serial' ? baudNumber : 0,
      boardName: boardName.trim(),
    };

    void run(input)
      .then((outcome) => {
        if (sequence.current !== seq) return;
        setResult(outcome);
        setPhase('done');
        if (outcome.ok) onInstalled?.();
      })
      .catch((cause: unknown) => {
        if (sequence.current !== seq) return;
        setRunError(cause instanceof Error ? cause.message : String(cause));
        setPhase('done');
      });
  };

  const backToForm = (): void => {
    sequence.current += 1;
    setPhase('form');
    setResult(null);
    setRunError(null);
    setCopyState('idle');
  };

  const resetAll = (): void => {
    sequence.current += 1;
    setPhase('form');
    setResult(null);
    setRunError(null);
    setCopyState('idle');
    setTransport('serial');
    setPort('');
    setBaud('1500000');
    setBoardName('');
  };

  const copyPath = (path: string): void => {
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) {
      setCopyState('failed');
      return;
    }
    void clipboard.writeText(path).then(
      () => setCopyState('copied'),
      () => setCopyState('failed'),
    );
  };

  const stageLabel =
    phase === 'done' && result !== null && !result.ok
      ? `停在第 ${stageIndex + 1} / 5 步 · ${STAGES[stageIndex]}`
      : `第 ${stageIndex + 1} / 5 步 · ${STAGES[stageIndex]}`;

  return (
    <div className="page page--wizard">
      <div className="wizard-wrap">
        <header className="page-head">
          <div className="page-head__text">
            <h1 className="page-head__title">接板向导</h1>
          </div>
        </header>

        <section className="wizard-card" aria-label="接板向导">
          <div className="wizard-progress">
            <div className="wizard-track" aria-hidden>
              {STAGES.map((stage, index) => (
                <span
                  key={stage}
                  className={`wizard-track__seg is-${railState(index)}`}
                  title={stage}
                />
              ))}
            </div>
            <p className={`wizard-stage${result !== null && !result.ok ? ' is-failed' : ''}`}>
              {stageLabel}
            </p>
          </div>

          {phase === 'done' && result !== null ? (
            <WizardOutcome
              result={result}
              copyState={copyState}
              onCopy={copyPath}
              onRetry={startRun}
              onAdjust={backToForm}
              onReset={resetAll}
            />
          ) : null}

          {phase === 'done' && runError !== null ? (
            <div className="wizard-result" role="status">
              <span className="state-chip state-chip--warn">没跑起来</span>
              <h2 className="wizard-result__title">向导没跑完</h2>
              <p className="wizard-failure__detail">{plain(runError)}</p>
              <div className="wizard-result__actions">
                <button type="button" className="btn btn--primary" onClick={startRun}>
                  重新试一次
                </button>
                <button type="button" className="btn btn--ghost" onClick={backToForm}>
                  改参数
                </button>
              </div>
            </div>
          ) : null}

          {phase !== 'done' ? (
            <form
              className="wizard-form"
              aria-busy={phase === 'running'}
              onSubmit={(event) => {
                event.preventDefault();
                startRun();
              }}
            >
              <div className="wizard-channel">
                <span className="wizard-label">怎么连</span>
                <div className="segmented wizard-segmented" role="group" aria-label="连接通道">
                  <button
                    type="button"
                    className={transport === 'serial' ? 'is-active' : undefined}
                    aria-pressed={transport === 'serial'}
                    disabled={phase === 'running'}
                    onClick={() => setTransport('serial')}
                  >
                    串口
                  </button>
                  <button
                    type="button"
                    className={transport === 'adb' ? 'is-active' : undefined}
                    aria-pressed={transport === 'adb'}
                    disabled={phase === 'running'}
                    onClick={() => setTransport('adb')}
                  >
                    ADB
                  </button>
                </div>
                <span className="wizard-channel__note">
                  {transport === 'serial'
                    ? '板子插着调试串口时选这个'
                    : '板子已经能用 adb 连上时选这个'}
                </span>
              </div>

              <div className="wizard-fields">
                <label className="wizard-field">
                  <span className="wizard-label">串口</span>
                  <input
                    name="port"
                    aria-label="串口"
                    value={port}
                    placeholder="COM3"
                    disabled={transport === 'adb' || phase === 'running'}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setPort(event.target.value)}
                  />
                  <span className="wizard-hint">
                    {transport === 'adb'
                      ? 'ADB 不需要串口；这一项保持原样即可'
                      : '手动填，例如 COM3'}
                  </span>
                </label>

                <label className="wizard-field">
                  <span className="wizard-label">波特率</span>
                  <input
                    name="baudrate"
                    aria-label="波特率"
                    value={baud}
                    inputMode="numeric"
                    list="wizard-baudrates"
                    disabled={transport === 'adb' || phase === 'running'}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setBaud(event.target.value.replace(/[^\d]/g, ''))}
                  />
                  <datalist id="wizard-baudrates">
                    {BAUD_RATES.map((rate) => (
                      <option key={rate} value={String(rate)}>
                        {rate === 1500000 ? `${rate} · 这块板是这个` : String(rate)}
                      </option>
                    ))}
                  </datalist>
                  <span className={`wizard-hint${baud.length > 0 && !baudOk ? ' is-warn' : ''}`}>
                    {transport === 'adb'
                      ? 'ADB 不经过串口，这个值用不上'
                      : baud.length > 0 && !baudOk
                        ? '填一个正整数，例如 1500000'
                        : '这块板是 1500000；其他板子按手册来'}
                  </span>
                </label>
              </div>

              <label className="wizard-field">
                <span className="wizard-label">板子名字</span>
                <input
                  name="boardName"
                  aria-label="板子名字"
                  value={boardName}
                  placeholder="我的 RK3588 板"
                  disabled={phase === 'running'}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setBoardName(event.target.value)}
                />
                <span className="wizard-hint">
                  之后它会成为包名和板的 id，中文也可以用；名字只影响叫法，不影响探到的能力。
                </span>
              </label>

              <div className="wizard-actions">
                <button
                  type="submit"
                  className="btn btn--primary wizard-start"
                  disabled={!canRun || phase === 'running'}
                >
                  <LinkIcon size={14} />
                  {phase === 'running' ? '正在接板…' : '开始接板'}
                </button>
                <p className="wizard-note">
                  一次调用跑完全程；中途不用再点，宿主的超时与重试都在里面。
                </p>
              </div>
            </form>
          ) : null}

          {phase === 'running' ? (
            <div className="wizard-wait" role="status" aria-live="polite">
              <div className="wizard-wait__head">
                <span className="wizard-wait__dot" aria-hidden />
                <strong className="wizard-wait__title">{waiting.title}</strong>
                <span className="wizard-wait__elapsed">
                  {Math.floor(elapsedMs / 1000)}s
                </span>
              </div>
              <p className="wizard-wait__detail">{waiting.detail}</p>
              <ol className="wizard-steps">
                {WAIT_STEPS.map((step) => {
                  const state =
                    step.index < waiting.index
                      ? 'done'
                      : step.index === waiting.index
                        ? 'active'
                        : 'pending';
                  return (
                    <li key={step.label} className={`is-${state}`}>
                      <span className="wizard-steps__dot" aria-hidden />
                      {step.label}
                    </li>
                  );
                })}
              </ol>
              <p className="wizard-note">
                宿主一次调用跑完全程，不回传进度；这里按耗时说它正在做什么，不编百分比。
              </p>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function WizardOutcome({
  result,
  copyState,
  onCopy,
  onRetry,
  onAdjust,
  onReset,
}: {
  result: WizardRunResult;
  copyState: 'idle' | 'copied' | 'failed';
  onCopy: (path: string) => void;
  onRetry: () => void;
  onAdjust: () => void;
  onReset: () => void;
}): JSX.Element {
  if (!result.ok) {
    const hints = hintsFor(result.kind, result.hints);
    const detail = detailOf(result.message);
    return (
      <div className="wizard-result wizard-result--failed" role="status">
        <h2 className="wizard-result__title">{RESULT_TITLE[result.kind]}</h2>
        {detail.length > 0 ? <p className="wizard-failure__detail">{detail}</p> : null}
        {hints.length > 0 ? (
          <div className="wizard-hints">
            <h3>下一步查什么</h3>
            <ol>
              {hints.map((hint) => (
                <li key={hint}>{hint}</li>
              ))}
            </ol>
          </div>
        ) : null}
        <div className="wizard-result__actions">
          <button type="button" className="btn btn--primary" onClick={onRetry}>
            重新试一次
          </button>
          <button type="button" className="btn btn--ghost" onClick={onAdjust}>
            改参数
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="wizard-result wizard-result--ok" role="status">
      <span className="state-chip state-chip--ok">成了</span>
      <h2 className="wizard-result__title">这块板现在有自己的包了</h2>

      <p className="wizard-result__summary">
        <strong>{result.greenCount}</strong> 个可用
        <span className="wizard-dot" aria-hidden>
          ·
        </span>
        <strong>{result.redCount}</strong> 个不可用
      </p>

      {result.redCount > 0 ? (
        <p className="wizard-result__warn">
          <AlertIcon size={13} />
          不可用的能力不会写进包里；这不是失败，是这块板没有它们。
        </p>
      ) : null}

      {result.installedDir !== undefined ? (
        <div className="wizard-installed">
          <span className="wizard-installed__label">包落在</span>
          <code>{result.installedDir}</code>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              if (result.installedDir !== undefined) onCopy(result.installedDir);
            }}
          >
            <CopyIcon size={12} />
            {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制'}
          </button>
        </div>
      ) : (
        <p className="wizard-hint">宿主没有回报包的位置；连接已经建好，可以从顶栏切过去。</p>
      )}

      {result.boardId !== undefined ? (
        <p className="wizard-result__id">板的 id · {result.boardId}</p>
      ) : null}

      <p className="wizard-caveat">
        <AlertIcon size={13} />
        <span>
          这是自动探出来的初版包：说得准的是事实（有没有、几个），说不准的是命名与语义
          —— 哪个温区是 SoC、哪根线是这一路，得让 agent 到板子上补。先用它把板子接上，
          再慢慢把包改准。
        </span>
      </p>

      <div className="wizard-result__actions">
        <button type="button" className="btn btn--primary" onClick={onReset}>
          再配一块
        </button>
        <button type="button" className="btn btn--ghost" onClick={onAdjust}>
          改参数
        </button>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import type { WizardRunResult } from '../../../shared/ipc-contract';
import { useT, type Localised } from '../i18n';
import { AlertIcon, CopyIcon, LinkIcon } from '../Icons';

/**
 * **Attaching a board it has not seen before** (the person takes one step ✓).
 *
 * The person picks a transport, fills in the serial port and the name, and
 * then one call does the rest:
 * build the connection → try 13 meta operations → generate the pack → install it.
 *
 * **The interface does not invent progress** ✗ — the host reports no interim
 * state; the page says what is happening, states plainly that the stages are
 * ordered by elapsed time, and draws no percentage.
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

/**
 * **Interface wording** —— every string the user can read is in this table ✓.
 *
 * Each entry sits next to the code that uses it, and `t()` picks the one for
 * the active locale ✓.
 */
const strings = {
  title: { 'zh-Hans': '接板向导', en: 'Board setup wizard' },

  // ── 阶段轨道 ──
  stageParameters: { 'zh-Hans': '参数', en: 'Parameters' },
  stageFirstTruth: { 'zh-Hans': '建立第一个真相', en: 'Establish the first truth' },
  stageMetaOps: { 'zh-Hans': '试元操作', en: 'Try the meta operations' },
  stageGenerate: { 'zh-Hans': '生成包', en: 'Generate the pack' },
  stageResult: { 'zh-Hans': '结果', en: 'Result' },
  stageStopped: { 'zh-Hans': '停在第', en: 'Stopped at step' },
  stageCurrent: { 'zh-Hans': '第', en: 'Step' },
  /** "Step" is a Chinese word; in English the step is only the separator. */
  stageTail: { 'zh-Hans': ' 步 · ', en: ' · ' },

  // ── 等待阶段 ──
  metaOpsTitle: { 'zh-Hans': '试 13 个元操作', en: 'Try the 13 meta operations' },
  firstPackTitle: { 'zh-Hans': '生成初版包', en: 'Generate the first pack' },
  firstTruthDetail: {
    'zh-Hans': '打开串口，先让板子回一句话。它回了，这条路才算成立。',
    en: 'Open the serial port and get one line back from the board. Once it answers, this path is real.',
  },
  metaOpsDetail: {
    'zh-Hans': '逐个确认这块板有没有这些能力。全部试完才会生成包。',
    en: 'Confirm one by one whether this board has these capabilities. The pack is generated only after every one of them has been tried.',
  },
  firstPackDetail: {
    'zh-Hans': '绿的留下，红的删掉，然后把包和它的来路写进用户目录。',
    en: 'The green ones stay and the red ones are dropped, then the pack and where it came from are written into the user directory.',
  },

  // ── 结果标题 ──
  resultOk: { 'zh-Hans': '这块板现在有自己的包了', en: 'This board now has its own pack' },
  resultPortUnopenable: { 'zh-Hans': '串口打不开', en: 'The serial port will not open' },
  resultNoReply: { 'zh-Hans': '板子没说话', en: 'The board did not answer' },
  resultConnectionDead: { 'zh-Hans': '那条连接一次都没通', en: 'That connection never came up' },

  // ── 失败提示 ──
  hintPortExclusive: {
    'zh-Hans': '最常见的情况不是口选错，是有别的程序正独占着那个口（串口助手、终端、另一个 IDE）。',
    en: 'Most of the time the port is not the wrong one — another program is holding it exclusively (a serial assistant, a terminal, another IDE).',
  },
  hintPortCloseIt: {
    'zh-Hans': '关掉占用它的程序，或者把那个程序里的串口断开，再重新试一次。',
    en: 'Close the program that holds it, or disconnect the serial port inside that program, then try again.',
  },
  hintPortConfirmDebug: {
    'zh-Hans': '确认选的确实是板子的调试口，而不是另一个 USB 转串口。',
    en: 'Make sure the port really is the debug port of the board, not another USB-to-serial adapter.',
  },
  hintBaudFirst: {
    'zh-Hans': '先把波特率换成 1500000 —— 这块板要的就是这个速率，其他速率它不会回话。',
    en: 'Set the baud rate to 1500000 first — this board needs exactly that rate, at any other rate it will not answer.',
  },
  hintConfirmDebugPort: {
    'zh-Hans': '确认串口号是板子的调试口，不是普通 USB 口或另一个设备的串口。',
    en: 'Check that the port is the debug port of the board, not a plain USB port or the serial port of another device.',
  },
  hintCloseAssistant: {
    'zh-Hans': '如果你刚打开过串口助手，先关掉它，确认回包没有被别的程序吃掉。',
    en: 'If you just opened a serial assistant, close it and make sure another program is not swallowing the replies.',
  },
  hintNeedsPower: {
    'zh-Hans': '板子要上电并停在 Linux 里；只插了 USB、系统没起来时，它不会说话。',
    en: 'The board has to be powered on and sitting in Linux; with only USB plugged in and the system not up, it does not speak.',
  },
  hintCheckLink: {
    'zh-Hans': '先查连接本身：线有没有插稳、板子有没有上电、串口号在设备管理器里还在不在。',
    en: 'Check the connection itself first: is the cable seated, is the board powered, does the port still show up in Device Manager.',
  },
  hintNotMetaOps: {
    'zh-Hans': '先别怀疑元操作 —— 一条命令都没跑通时，问题一定在更下面。',
    en: 'Do not suspect the meta operations yet — when not one command runs, the problem is further down.',
  },
  hintChangeCable: {
    'zh-Hans': '换一条能确认可用的数据线，或者换一个 USB 口，再重新试一次。',
    en: 'Try a data cable you know works, or a different USB port, and try again.',
  },

  // ── 表单 ──
  howToConnect: { 'zh-Hans': '怎么连', en: 'How to connect' },
  channelGroup: { 'zh-Hans': '连接通道', en: 'Connection channel' },
  serial: { 'zh-Hans': '串口', en: 'Serial port' },
  serialChannelNote: {
    'zh-Hans': '板子插着调试串口时选这个',
    en: 'Pick this when the board sits on its debug serial port',
  },
  adbChannelNote: {
    'zh-Hans': '板子已经能用 adb 连上时选这个',
    en: 'Pick this when the board already answers over adb',
  },
  adbNoPort: {
    'zh-Hans': 'ADB 不需要串口；这一项保持原样即可',
    en: 'ADB needs no serial port; leave this field as it is',
  },
  portManual: { 'zh-Hans': '手动填，例如 COM3', en: 'Type it in, for example COM3' },
  baudRate: { 'zh-Hans': '波特率', en: 'Baud rate' },
  thisBoardRate: { 'zh-Hans': '这块板是这个', en: 'this is the one for this board' },
  adbNoBaud: {
    'zh-Hans': 'ADB 不经过串口，这个值用不上',
    en: 'ADB does not go through the serial port, so this value is unused',
  },
  baudPositive: {
    'zh-Hans': '填一个正整数，例如 1500000',
    en: 'Enter a positive integer, for example 1500000',
  },
  baudManual: {
    'zh-Hans': '这块板是 1500000；其他板子按手册来',
    en: 'This board is 1500000; other boards follow their manual',
  },
  boardName: { 'zh-Hans': '板子名字', en: 'Board name' },
  boardNamePlaceholder: { 'zh-Hans': '我的 RK3588 板', en: 'My RK3588 board' },
  boardNameHint: {
    'zh-Hans': '之后它会成为包名和板的 id，中文也可以用；名字只影响叫法，不影响探到的能力。',
    en: 'It becomes the pack name and the board id afterwards; Chinese is fine. The name only affects what it is called, not the capabilities that are probed.',
  },
  start: { 'zh-Hans': '开始接板', en: 'Start setup' },
  starting: { 'zh-Hans': '正在接板…', en: 'Setting up…' },
  oneCallNote: {
    'zh-Hans': '一次调用跑完全程；中途不用再点，宿主的超时与重试都在里面。',
    en: 'One call runs the whole way; there is nothing to click on the way, the host timeouts and retries are inside it.',
  },
  noProgressNote: {
    'zh-Hans': '宿主一次调用跑完全程，不回传进度；这里按耗时说它正在做什么，不编百分比。',
    en: 'The host runs the whole way in one call and reports no progress; this screen says what it is doing by elapsed time and invents no percentage.',
  },

  // ── 失败与重试 ──
  didNotStart: { 'zh-Hans': '没跑起来', en: 'Did not start' },
  wizardNotFinished: { 'zh-Hans': '向导没跑完', en: 'The wizard did not finish' },
  retry: { 'zh-Hans': '重新试一次', en: 'Try again' },
  adjust: { 'zh-Hans': '改参数', en: 'Change parameters' },
  whatToCheck: { 'zh-Hans': '下一步查什么', en: 'What to check next' },

  // ── 成功 ──
  done: { 'zh-Hans': '成了', en: 'Done' },
  countAvailable: { 'zh-Hans': '个可用', en: 'available' },
  countUnavailable: { 'zh-Hans': '个不可用', en: 'unavailable' },
  unavailableNote: {
    'zh-Hans': '不可用的能力不会写进包里；这不是失败，是这块板没有它们。',
    en: 'Unavailable capabilities are not written into the pack; this is not a failure, the board simply does not have them.',
  },
  packLandedAt: { 'zh-Hans': '包落在', en: 'Pack landed at' },
  copy: { 'zh-Hans': '复制', en: 'Copy' },
  copied: { 'zh-Hans': '已复制', en: 'Copied' },
  copyFailed: { 'zh-Hans': '复制失败', en: 'Copy failed' },
  noPackLocation: {
    'zh-Hans': '宿主没有回报包的位置；连接已经建好，可以从顶栏切过去。',
    en: 'The host did not report where the pack landed; the connection is up, so you can switch to it from the top bar.',
  },
  boardIdLabel: { 'zh-Hans': '板的 id ·', en: 'Board id ·' },
  caveat: {
    'zh-Hans': '这是自动探出来的初版包：说得准的是事实（有没有、几个），说不准的是命名与语义 —— 哪个温区是 SoC、哪根线是这一路，得让 agent 到板子上补。先用它把板子接上，再慢慢把包改准。',
    en: 'This is the first pack, probed automatically: what it states as fact (whether a capability exists, how many) is reliable, while the naming and the semantics are not — which thermal zone is the SoC and which wire carries this rail has to be filled in by the agent on the board. Use it to get the board connected first, then make the pack more accurate.',
  },
  anotherBoard: { 'zh-Hans': '再配一块', en: 'Set up another board' },
} satisfies Record<string, Localised>;

const STAGES: readonly Localised[] = [
  strings.stageParameters,
  strings.stageFirstTruth,
  strings.stageMetaOps,
  strings.stageGenerate,
  strings.stageResult,
];

const WAIT_STEPS: readonly { index: number; label: Localised }[] = [
  { index: 1, label: strings.stageFirstTruth },
  { index: 2, label: strings.metaOpsTitle },
  { index: 3, label: strings.firstPackTitle },
];

const RESULT_TITLE: Record<WizardRunResult['kind'], Localised> = {
  ok: strings.resultOk,
  'port-unopenable': strings.resultPortUnopenable,
  'no-reply': strings.resultNoReply,
  'connection-dead': strings.resultConnectionDead,
};

const FALLBACK_HINTS: Record<WizardRunResult['kind'], readonly Localised[]> = {
  ok: [],
  'port-unopenable': [
    strings.hintPortExclusive,
    strings.hintPortCloseIt,
    strings.hintPortConfirmDebug,
  ],
  'no-reply': [
    strings.hintBaudFirst,
    strings.hintConfirmDebugPort,
    strings.hintCloseAssistant,
    strings.hintNeedsPower,
  ],
  'connection-dead': [
    strings.hintCheckLink,
    strings.hintNotMetaOps,
    strings.hintChangeCable,
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

/** The host writes `title —— detail`; the detail is what belongs under our headline. */
function detailOf(message: string): string {
  const cleaned = plain(message);
  const at = cleaned.indexOf('——');
  return (at >= 0 ? cleaned.slice(at + 3) : cleaned).trim();
}

/**
 * The hints of a failure.
 *
 * The host's own hints come as plain text, so they are carried in both
 * branches unchanged; the fallback hints below are localised.
 */
function hintsFor(kind: WizardRunResult['kind'], hints: readonly string[]): Localised[] {
  const seen = new Set<string>();
  const merged: Localised[] = [
    ...hints.map((hint) => ({ 'zh-Hans': plain(hint), en: plain(hint) })),
    ...FALLBACK_HINTS[kind],
  ];
  return merged.filter((hint) => {
    const text = hint['zh-Hans'];
    if (text.length === 0 || seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}

function failureStep(): number {
  // Every failure we can name happens while trying to get the first truth:
  // the port never opened, it opened but nothing came back, or the link died.
  return 1;
}

function waitDetail(
  elapsedMs: number,
  t: (text: Localised) => string,
): {
  index: number;
  title: string;
  detail: string;
} {
  // The first command has a 5s timeout in the host; after that the probes are
  // the long part. These are descriptions of the stage, not a progress bar.
  if (elapsedMs < 6_000) {
    return {
      index: 1,
      title: t(strings.stageFirstTruth),
      detail: t(strings.firstTruthDetail),
    };
  }
  if (elapsedMs < 75_000) {
    return {
      index: 2,
      title: t(strings.metaOpsTitle),
      detail: t(strings.metaOpsDetail),
    };
  }
  return {
    index: 3,
    title: t(strings.firstPackTitle),
    detail: t(strings.firstPackDetail),
  };
}

export function WizardPage({ run, onInstalled }: WizardPageProps): JSX.Element {
  const t = useT();
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
  const waiting = waitDetail(elapsedMs, t);

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

  const stageText = t(STAGES[stageIndex]);
  const stageLabel =
    phase === 'done' && result !== null && !result.ok
      ? `${t(strings.stageStopped)} ${stageIndex + 1} / ${STAGES.length}${t(strings.stageTail)}${stageText}`
      : `${t(strings.stageCurrent)} ${stageIndex + 1} / ${STAGES.length}${t(strings.stageTail)}${stageText}`;

  return (
    <div className="page page--wizard">
      <div className="wizard-wrap">
        <header className="page-head">
          <div className="page-head__text">
            <h1 className="page-head__title">{t(strings.title)}</h1>
          </div>
        </header>

        <section className="wizard-card" aria-label={t(strings.title)}>
          <div className="wizard-progress">
            <div className="wizard-track" aria-hidden>
              {STAGES.map((stage, index) => (
                <span
                  key={stage['zh-Hans']}
                  className={`wizard-track__seg is-${railState(index)}`}
                  title={t(stage)}
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
              <span className="state-chip state-chip--warn">{t(strings.didNotStart)}</span>
              <h2 className="wizard-result__title">{t(strings.wizardNotFinished)}</h2>
              <p className="wizard-failure__detail">{plain(runError)}</p>
              <div className="wizard-result__actions">
                <button type="button" className="btn btn--primary" onClick={startRun}>
                  {t(strings.retry)}
                </button>
                <button type="button" className="btn btn--ghost" onClick={backToForm}>
                  {t(strings.adjust)}
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
                <span className="wizard-label">{t(strings.howToConnect)}</span>
                <div className="segmented wizard-segmented" role="group" aria-label={t(strings.channelGroup)}>
                  <button
                    type="button"
                    className={transport === 'serial' ? 'is-active' : undefined}
                    aria-pressed={transport === 'serial'}
                    disabled={phase === 'running'}
                    onClick={() => setTransport('serial')}
                  >
                    {t(strings.serial)}
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
                  {transport === 'serial' ? t(strings.serialChannelNote) : t(strings.adbChannelNote)}
                </span>
              </div>

              <div className="wizard-fields">
                <label className="wizard-field">
                  <span className="wizard-label">{t(strings.serial)}</span>
                  <input
                    name="port"
                    aria-label={t(strings.serial)}
                    value={port}
                    placeholder="COM3"
                    disabled={transport === 'adb' || phase === 'running'}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setPort(event.target.value)}
                  />
                  <span className="wizard-hint">
                    {transport === 'adb' ? t(strings.adbNoPort) : t(strings.portManual)}
                  </span>
                </label>

                <label className="wizard-field">
                  <span className="wizard-label">{t(strings.baudRate)}</span>
                  <input
                    name="baudrate"
                    aria-label={t(strings.baudRate)}
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
                        {rate === 1500000 ? `${rate} · ${t(strings.thisBoardRate)}` : String(rate)}
                      </option>
                    ))}
                  </datalist>
                  <span className={`wizard-hint${baud.length > 0 && !baudOk ? ' is-warn' : ''}`}>
                    {transport === 'adb'
                      ? t(strings.adbNoBaud)
                      : baud.length > 0 && !baudOk
                        ? t(strings.baudPositive)
                        : t(strings.baudManual)}
                  </span>
                </label>
              </div>

              <label className="wizard-field">
                <span className="wizard-label">{t(strings.boardName)}</span>
                <input
                  name="boardName"
                  aria-label={t(strings.boardName)}
                  value={boardName}
                  placeholder={t(strings.boardNamePlaceholder)}
                  disabled={phase === 'running'}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setBoardName(event.target.value)}
                />
                <span className="wizard-hint">{t(strings.boardNameHint)}</span>
              </label>

              <div className="wizard-actions">
                <button
                  type="submit"
                  className="btn btn--primary wizard-start"
                  disabled={!canRun || phase === 'running'}
                >
                  <LinkIcon size={14} />
                  {phase === 'running' ? t(strings.starting) : t(strings.start)}
                </button>
                <p className="wizard-note">{t(strings.oneCallNote)}</p>
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
                    <li key={step.label['zh-Hans']} className={`is-${state}`}>
                      <span className="wizard-steps__dot" aria-hidden />
                      {t(step.label)}
                    </li>
                  );
                })}
              </ol>
              <p className="wizard-note">{t(strings.noProgressNote)}</p>
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
  const t = useT();
  if (!result.ok) {
    const hints = hintsFor(result.kind, result.hints);
    const detail = detailOf(result.message);
    return (
      <div className="wizard-result wizard-result--failed" role="status">
        <h2 className="wizard-result__title">{t(RESULT_TITLE[result.kind])}</h2>
        {detail.length > 0 ? <p className="wizard-failure__detail">{detail}</p> : null}
        {hints.length > 0 ? (
          <div className="wizard-hints">
            <h3>{t(strings.whatToCheck)}</h3>
            <ol>
              {hints.map((hint) => (
                <li key={hint['zh-Hans']}>{t(hint)}</li>
              ))}
            </ol>
          </div>
        ) : null}
        <div className="wizard-result__actions">
          <button type="button" className="btn btn--primary" onClick={onRetry}>
            {t(strings.retry)}
          </button>
          <button type="button" className="btn btn--ghost" onClick={onAdjust}>
            {t(strings.adjust)}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="wizard-result wizard-result--ok" role="status">
      <span className="state-chip state-chip--ok">{t(strings.done)}</span>
      <h2 className="wizard-result__title">{t(strings.resultOk)}</h2>

      <p className="wizard-result__summary">
        <strong>{result.greenCount}</strong>
        {' '}
        {t(strings.countAvailable)}
        <span className="wizard-dot" aria-hidden>
          ·
        </span>
        <strong>{result.redCount}</strong>
        {' '}
        {t(strings.countUnavailable)}
      </p>

      {result.redCount > 0 ? (
        <p className="wizard-result__warn">
          <AlertIcon size={13} />
          {t(strings.unavailableNote)}
        </p>
      ) : null}

      {result.installedDir !== undefined ? (
        <div className="wizard-installed">
          <span className="wizard-installed__label">{t(strings.packLandedAt)}</span>
          <code>{result.installedDir}</code>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              if (result.installedDir !== undefined) onCopy(result.installedDir);
            }}
          >
            <CopyIcon size={12} />
            {copyState === 'copied'
              ? t(strings.copied)
              : copyState === 'failed'
                ? t(strings.copyFailed)
                : t(strings.copy)}
          </button>
        </div>
      ) : (
        <p className="wizard-hint">{t(strings.noPackLocation)}</p>
      )}

      {result.boardId !== undefined ? (
        <p className="wizard-result__id">
          {t(strings.boardIdLabel)} {result.boardId}
        </p>
      ) : null}

      <p className="wizard-caveat">
        <AlertIcon size={13} />
        <span>{t(strings.caveat)}</span>
      </p>

      <div className="wizard-result__actions">
        <button type="button" className="btn btn--primary" onClick={onReset}>
          {t(strings.anotherBoard)}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onAdjust}>
          {t(strings.adjust)}
        </button>
      </div>
    </div>
  );
}
import { useEffect, useRef, useState } from 'react';
import type { WizardRunResult } from '../../../shared/ipc-contract';
import type { BoardDetection } from '../../../shared/board-setup';
import { useT, type Localised } from '../i18n';
import { CopyIcon, LinkIcon, RefreshIcon } from '../Icons';

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
  boardName?: string;
  transport?: Transport;
}

export interface WizardPageProps {
  /** Injected by the shell so the page stays testable without `window.cockpit`. */
  run: (input: WizardRequest) => Promise<WizardRunResult>;
  /** Reads the serial ports of this machine; the card sets no path by hand. */
  detect?: () => Promise<BoardDetection>;
  /** Called once after a pack lands, so the shell can refresh connections/cards. */
  onInstalled?: () => void;
  /** Closes the independent setup surface. */
  onClose?: () => void;
}

const BAUD_RATES = [1500000, 115200, 921600, 460800, 230400, 57600, 9600] as const;

/**
 * **Interface wording** —— every string the user can read is in this table ✓.
 *
 * Each entry sits next to the code that uses it, and `t()` picks the one for
 * the active locale ✓.
 */
const strings = {
  title: { 'zh-Hans': '添加开发板', en: 'Add board' },

  // ── Stage track ──
  stageParameters: { 'zh-Hans': '详情', en: 'Details' },
  stageConnecting: { 'zh-Hans': '连接', en: 'Connect' },
  stageFirstTruth: { 'zh-Hans': '建立连接', en: 'Connect' },
  stageMetaOps: { 'zh-Hans': '检测开发板能力', en: 'Detect capabilities' },
  stageGenerate: { 'zh-Hans': '生成板卡配置', en: 'Generate board profile' },
  stageResult: { 'zh-Hans': '结果', en: 'Result' },
  stageStopped: { 'zh-Hans': '第', en: 'Step' },
  stageFailedTail: { 'zh-Hans': ' 步失败 · ', en: ' failed · ' },

  // ── Waiting for a stage ──
  metaOpsTitle: { 'zh-Hans': '检测开发板能力', en: 'Detect board capabilities' },
  firstPackTitle: { 'zh-Hans': '生成板卡配置', en: 'Generate the board profile' },
  firstTruthDetail: {
    'zh-Hans': '正在建立串口连接',
    en: 'Establishing the connection',
  },
  metaOpsDetail: {
    'zh-Hans': '正在检测开发板能力',
    en: 'Detecting board capabilities',
  },
  firstPackDetail: {
    'zh-Hans': '正在生成板卡配置',
    en: 'Generating the board profile',
  },

  // ── Result headline ──
  resultOk: { 'zh-Hans': '开发板已添加', en: 'Board added' },
  resultPortUnopenable: { 'zh-Hans': '无法打开串口', en: 'Cannot open the serial port' },
  resultNoReply: { 'zh-Hans': '开发板无响应', en: 'The board did not respond' },
  resultConnectionDead: { 'zh-Hans': '连接未建立', en: 'Connection not established' },

  // ── Failure hints ──
  hintPortExclusive: {
    'zh-Hans': '关闭占用该串口的程序',
    en: 'Close the program holding the serial port',
  },
  hintPortCloseIt: {
    'zh-Hans': '重新连接开发板',
    en: 'Connect again',
  },
  hintPortConfirmDebug: {
    'zh-Hans': '确认开发板调试串口',
    en: 'Choose the debug serial port',
  },
  hintBaudFirst: {
    'zh-Hans': '波特率设为 1500000',
    en: 'Baud rate 1500000',
  },
  hintConfirmDebugPort: {
    'zh-Hans': '确认开发板调试串口',
    en: 'Choose the debug serial port',
  },
  hintCloseAssistant: {
    'zh-Hans': '关闭串口调试工具',
    en: 'Close the serial assistant',
  },
  hintNeedsPower: {
    'zh-Hans': '确认开发板已上电',
    en: 'Power on the board',
  },
  hintCheckLink: {
    'zh-Hans': '检查数据线与供电',
    en: 'Check the cable and power',
  },
  hintNotMetaOps: {
    'zh-Hans': '检查物理连接',
    en: 'Check the physical connection',
  },
  hintChangeCable: {
    'zh-Hans': '更换数据线或 USB 端口',
    en: 'Change the cable or USB port',
  },

  // ── Form ──
  boardDetails: { 'zh-Hans': '设备信息', en: 'Device' },
  detectedBoard: { 'zh-Hans': '检测结果', en: 'Detected' },
  connectionDetails: { 'zh-Hans': '连接参数', en: 'Connection' },
  howToConnect: { 'zh-Hans': '连接方式', en: 'Method' },
  channelGroup: { 'zh-Hans': '连接方式', en: 'Connection method' },
  serial: { 'zh-Hans': '串口', en: 'Serial port' },
  serialDetecting: { 'zh-Hans': '正在查找串口…', en: 'Finding serial ports…' },
  serialNone: { 'zh-Hans': '未检测到串口', en: 'No serial port found' },
  serialAnswers: { 'zh-Hans': '已响应', en: 'Responds' },
  refreshPorts: { 'zh-Hans': '刷新串口', en: 'Refresh serial ports' },
  baudRate: { 'zh-Hans': '波特率', en: 'Baud rate' },
  start: { 'zh-Hans': '建立连接', en: 'Connect' },
  starting: { 'zh-Hans': '正在连接…', en: 'Connecting…' },

  // ── Failure and retry ──
  didNotStart: { 'zh-Hans': '未启动', en: 'Did not start' },
  wizardNotFinished: { 'zh-Hans': '添加开发板失败', en: 'Could not add the board' },
  retry: { 'zh-Hans': '重试', en: 'Retry' },
  adjust: { 'zh-Hans': '修改参数', en: 'Edit parameters' },
  whatToCheck: { 'zh-Hans': '检查项', en: 'Checks' },

  // ── Success ──
  done: { 'zh-Hans': '已完成', en: 'Done' },
  countAvailable: { 'zh-Hans': '项可用', en: 'available' },
  countUnavailable: { 'zh-Hans': '项不可用', en: 'unavailable' },
  initialPack: { 'zh-Hans': '初始配置', en: 'Initial profile' },
  packLandedAt: { 'zh-Hans': '配置目录', en: 'Profile directory' },
  copy: { 'zh-Hans': '复制', en: 'Copy' },
  copied: { 'zh-Hans': '已复制', en: 'Copied' },
  copyFailed: { 'zh-Hans': '复制失败', en: 'Copy failed' },
  noPackLocation: {
    'zh-Hans': '安装目录不可用',
    en: 'Install directory unavailable',
  },
  boardIdLabel: { 'zh-Hans': '开发板 ID ·', en: 'Board ID ·' },
  anotherBoard: { 'zh-Hans': '添加另一块开发板', en: 'Add another board' },
  close: { 'zh-Hans': '完成', en: 'Done' },
} satisfies Record<string, Localised>;

const STAGES: readonly Localised[] = [
  strings.stageParameters,
  strings.stageConnecting,
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
function hintsFor(kind: WizardRunResult['kind']): Localised[] {
  const seen = new Set<string>();
  return FALLBACK_HINTS[kind].filter((hint) => {
    const text = hint['zh-Hans'];
    if (text.length === 0 || seen.has(text)) return false;
    seen.add(text);
    return true;
  });
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

export function WizardPage({
  run,
  detect,
  onInstalled,
  onClose,
}: WizardPageProps): JSX.Element {
  const t = useT();
  const [transport, setTransport] = useState<Transport>('serial');
  const [port, setPort] = useState('');
  const [ports, setPorts] = useState<BoardDetection['ports']>([]);
  const [detectedModel, setDetectedModel] = useState<string | null>(null);
  const [detectBusy, setDetectBusy] = useState(false);
  const [detectError, setDetectError] = useState(false);
  const [baud, setBaud] = useState('1500000');
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

  const loadPorts = (): void => {
    if (detect === undefined || detectBusy) return;
    setDetectBusy(true);
    setDetectError(false);
    void detect()
      .then((found) => {
        setPorts(found.ports);
        setDetectedModel(found.model);
        setPort((current) => {
          if (found.ports.some((candidate) => candidate.path === current)) return current;
          return found.ports.find((candidate) => candidate.answered)?.path ?? found.ports[0]?.path ?? '';
        });
      })
      .catch(() => setDetectError(true))
      .finally(() => setDetectBusy(false));
  };

  useEffect(() => {
    loadPorts();
  }, []);

  const baudNumber = Number(baud);
  const baudOk = Number.isInteger(baudNumber) && baudNumber > 0;
  const portOk = transport === 'adb' || port.trim().length > 0;
  const canRun = portOk && baudOk;
  const elapsedMs = Math.max(0, now - startedAt.current);
  const waiting = waitDetail(elapsedMs, t);

  const stageIndex =
    phase === 'form'
      ? 0
      : phase === 'running'
        ? 1
        : result !== null && !result.ok
          ? 1
          : 2;

  const railState = (index: number): 'done' | 'current' | 'failed' | 'pending' => {
    if (phase === 'form') return index === 0 ? 'current' : 'pending';
    if (phase === 'running') return index < 1 ? 'done' : index === 1 ? 'current' : 'pending';
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
      ? `${t(strings.stageStopped)} ${stageIndex + 1}/${STAGES.length}${t(strings.stageFailedTail)}${stageText}`
      : `${stageIndex + 1} / ${STAGES.length} · ${stageText}`;

  return (
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
          onClose={onClose}
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
          className={`wizard-form${phase === 'running' ? ' is-running' : ''}`}
          aria-busy={phase === 'running'}
          onSubmit={(event) => {
            event.preventDefault();
            startRun();
          }}
        >
          <div className="wizard-form__grid">
            <section className="wizard-form__section">
              <header className="wizard-section-head">
                <span className="wizard-section-head__index">01</span>
                <h2>{t(strings.boardDetails)}</h2>
              </header>
              <div className="wizard-detected">
                <span className="wizard-label">{t(strings.detectedBoard)}</span>
                <strong>{detectedModel ?? '—'}</strong>
              </div>
            </section>

            <section className="wizard-form__section">
              <header className="wizard-section-head">
                <span className="wizard-section-head__index">02</span>
                <h2>{t(strings.connectionDetails)}</h2>
              </header>
              <div className="wizard-channel">
                <span className="wizard-label">{t(strings.howToConnect)}</span>
                <div
                  className="segmented wizard-segmented"
                  role="group"
                  aria-label={t(strings.channelGroup)}
                >
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
              </div>

              <div className="wizard-fields">
                <label className="wizard-field">
                  <span className="wizard-label">{t(strings.serial)}</span>
                  <span className="wizard-select-row">
                  <select
                    name="port"
                    aria-label={t(strings.serial)}
                    value={port}
                    disabled={transport === 'adb' || phase === 'running'}
                    onChange={(event) => setPort(event.target.value)}
                    data-wizard-autofocus
                  >
                    <option value="">
                      {detectBusy
                        ? t(strings.serialDetecting)
                        : ports.length === 0
                          ? t(strings.serialNone)
                          : '—'}
                    </option>
                    {ports.map((candidate) => (
                      <option key={candidate.path} value={candidate.path}>
                        {candidate.path}
                        {candidate.answered ? ` · ${t(strings.serialAnswers)}` : ''}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="icon-btn icon-btn--quiet"
                    aria-label={t(strings.refreshPorts)}
                    title={t(strings.refreshPorts)}
                    disabled={detectBusy || phase === 'running'}
                    onClick={loadPorts}
                  >
                    <RefreshIcon size={14} />
                  </button>
                  </span>
                  {detectError ? (
                    <span className="wizard-hint is-warn">{t(strings.serialNone)}</span>
                  ) : null}
                </label>

                <label className="wizard-field">
                  <span className="wizard-label">{t(strings.baudRate)}</span>
                  <select
                    name="baudrate"
                    aria-label={t(strings.baudRate)}
                    value={baud}
                    disabled={transport === 'adb' || phase === 'running'}
                    onChange={(event) => setBaud(event.target.value)}
                  >
                    {BAUD_RATES.map((rate) => (
                      <option key={rate} value={String(rate)}>
                        {String(rate)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </section>
          </div>

          <div className="wizard-actions">
            <button
              type="submit"
              className="btn btn--primary wizard-start"
              disabled={!canRun || phase === 'running'}
            >
              <LinkIcon size={14} />
              {phase === 'running' ? t(strings.starting) : t(strings.start)}
            </button>
          </div>
        </form>
      ) : null}

      {phase === 'running' ? (
        <div className="wizard-wait" role="status" aria-live="polite">
          <div className="wizard-wait__head">
            <span className="wizard-wait__dot" aria-hidden />
            <strong className="wizard-wait__title">{waiting.title}</strong>
            <span className="wizard-wait__elapsed">{Math.floor(elapsedMs / 1000)}s</span>
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
        </div>
      ) : null}
    </section>
  );
}

function WizardOutcome({
  result,
  copyState,
  onCopy,
  onRetry,
  onAdjust,
  onReset,
  onClose,
}: {
  result: WizardRunResult;
  copyState: 'idle' | 'copied' | 'failed';
  onCopy: (path: string) => void;
  onRetry: () => void;
  onAdjust: () => void;
  onReset: () => void;
  onClose?: () => void;
}): JSX.Element {
  const t = useT();
  if (!result.ok) {
    const hints = hintsFor(result.kind);
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
          <span className="state-chip state-chip--muted">{t(strings.initialPack)}</span>
          {t(strings.boardIdLabel)} {result.boardId}
        </p>
      ) : null}

      <div className="wizard-result__actions">
        {onClose ? (
          <button type="button" className="btn btn--primary" onClick={onClose}>
            {t(strings.close)}
          </button>
        ) : null}
        <button
          type="button"
          className={onClose ? 'btn btn--ghost' : 'btn btn--primary'}
          onClick={onReset}
        >
          {t(strings.anotherBoard)}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onAdjust}>
          {t(strings.adjust)}
        </button>
      </div>
    </div>
  );
}

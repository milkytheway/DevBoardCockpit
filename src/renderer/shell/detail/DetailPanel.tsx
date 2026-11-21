import { useCallback, useMemo, useState } from 'react';
import type { CardInstanceInfo } from '../../../shared/ipc-contract';
import type { TagReading } from '../../../shared/tag-reading';
import { cardLook } from '../cards';
import { interpolate, pick, useLocale, useT, type Locale, type Localised } from '../i18n';
import { CloseIcon, CopyIcon } from '../Icons';
import type { ActivityEntry, DetailTarget } from '../types';

/**
 * The right-hand detail panel.
 *
 * It is a **panel**, not a page: it appears when a card (or a session) is
 * selected and can be dragged wider from its left edge. For a card it answers
 * "what is this card doing to the board right now?": the tags it reads, the
 * raw `TagReading` objects behind them, the observed sampling cadence, and the
 * host activity that mentions it.
 *
 * The panel never invents data. What the host does not expose (a card's
 * manifest, its runtime log) is said out loud instead of being faked.
 */
type DetailTab = 'capture' | 'raw' | 'activity';

/**
 * The wording of the panel, in both languages.
 *
 * The panel is drawn from the shell's data, so it carries its own text and
 * resolves it against the active locale.
 */
const strings = {
  detail: { 'zh-Hans': '详情', en: 'Detail' },
  detailViews: { 'zh-Hans': '详情视图', en: 'Detail views' },
  close: { 'zh-Hans': '关闭详情', en: 'Close the detail panel' },
  resize: { 'zh-Hans': '拖动调整宽度', en: 'Drag to resize' },
  tabCapture: { 'zh-Hans': '采集', en: 'Capture' },
  tabRaw: { 'zh-Hans': '原始读数', en: 'Raw readings' },
  tabActivity: { 'zh-Hans': '活动', en: 'Activity' },
  sessionTitle: { 'zh-Hans': '终端 · {label}', en: 'Terminal · {label}' },
  copyDiagnostics: { 'zh-Hans': '复制诊断', en: 'Copy diagnostics' },
  removeCard: { 'zh-Hans': '从主区拿走', en: 'Take it out of the work area' },
  samplingFrom: { 'zh-Hans': '采样来自 {connection}', en: 'Sampled from {connection}' },
  connectionNotReady: {
    'zh-Hans': '当前连接未就绪',
    en: 'The current connection is not ready',
  },
  tagCount: { 'zh-Hans': '{count} 个位号', en: '{count} tags' },
  tagsNotPublished: {
    'zh-Hans': '位号清单未公开',
    en: 'The tag list is not published',
  },
  captureBehaviour: { 'zh-Hans': '采集行为', en: 'Capture behaviour' },
  unknownCard: {
    'zh-Hans': '自定义卡片 · 实时读数',
    en: 'Custom card · live readings',
  },
  notSampled: { 'zh-Hans': '未采样', en: 'Not sampled' },
  observed: {
    'zh-Hans': '{count} 次采样',
    en: '{count} samples',
  },
  instance: { 'zh-Hans': '实例', en: 'Instance' },
  connection: { 'zh-Hans': '连接', en: 'Connection' },
  layout: { 'zh-Hans': '布局', en: 'Layout' },
  state: { 'zh-Hans': '状态', en: 'State' },
  notConnected: { 'zh-Hans': '未连接', en: 'Not connected' },
  degradedRun: {
    'zh-Hans': '运行异常',
    en: 'Degraded',
  },
  healthy: { 'zh-Hans': '正常', en: 'Healthy' },
  sandbox: { 'zh-Hans': '沙箱', en: 'Sandbox' },
  storageHosted: { 'zh-Hans': '本地存储', en: 'Local storage' },
  latestRaw: { 'zh-Hans': '最新原始值', en: 'Latest raw values' },
  tagCountLabel: { 'zh-Hans': '{count} 个 tag', en: '{count} tags' },
  sampleStream: { 'zh-Hans': '采样流水', en: 'Sample stream' },
  entryCount: { 'zh-Hans': '{count} 条', en: '{count} entries' },
  noSamples: {
    'zh-Hans': '还没有采样',
    en: 'No samples yet',
  },
  streamHint: {
    'zh-Hans': '最近 120 条',
    en: 'Latest 120',
  },
  activity: { 'zh-Hans': '活动', en: 'Activity' },
  noActivity: {
    'zh-Hans': '没有相关活动',
    en: 'No activity',
  },
  statusOk: { 'zh-Hans': '正常', en: 'Ok' },
  statusStale: { 'zh-Hans': '已过时', en: 'Stale' },
  statusUnavailable: { 'zh-Hans': '不可用', en: 'Unavailable' },
  statusError: { 'zh-Hans': '读取失败', en: 'Read failed' },
  statusWaiting: { 'zh-Hans': '等待采样', en: 'Waiting for a sample' },
  booleanOn: { 'zh-Hans': '开', en: 'on' },
  booleanOff: { 'zh-Hans': '关', en: 'off' },
  justNow: { 'zh-Hans': '刚刚', en: 'just now' },
  secondsAgo: { 'zh-Hans': '{seconds} 秒前', en: '{seconds} s ago' },
  minutesAgo: { 'zh-Hans': '{minutes} 分钟前', en: '{minutes} min ago' },
  session: { 'zh-Hans': '会话', en: 'Session' },
  connectionId: { 'zh-Hans': '连接标识', en: 'Connection ID' },
  name: { 'zh-Hans': '名称', en: 'Name' },
} satisfies Record<string, Localised>;

export function DetailPanel({
  target,
  width,
  activity,
  readings,
  historyFor,
  sampleCount,
  onWidthChange,
  onClose,
  onCopyDiagnostics,
  onRemoveCard,
}: {
  target: DetailTarget;
  width: number;
  activity: ActivityEntry[];
  readings: TagReading[];
  historyFor: (tag: string) => readonly TagReading[];
  sampleCount: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
  onCopyDiagnostics: () => void;
  onRemoveCard: (card: CardInstanceInfo) => void;
}): JSX.Element | null {
  const [tab, setTab] = useState<DetailTab>('capture');

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const onMove = (move: PointerEvent): void => {
        const next = Math.min(640, Math.max(320, window.innerWidth - move.clientX));
        onWidthChange(next);
      };
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [onWidthChange],
  );

  const scoped = useActivityScope(target, activity);
  const t = useT();
  const locale = useLocale();

  if (target === null) return null;

  const isCard = target.kind === 'card';
  const look = isCard ? cardLook(target.card.cardId) : null;

  return (
    <aside className="detail" style={{ width }} aria-label={t(strings.detail)}>
      <div className="detail__resize" onPointerDown={startResize} title={t(strings.resize)} />
      <header className="detail__head">
        <div className="detail__heading">
          <span className="detail__eyebrow">{isCard ? 'CARD INSTANCE' : 'TERMINAL SESSION'}</span>
          <h2 className="detail__title">
            {isCard
              ? pick(look?.name, locale)
              : t(strings.sessionTitle, { label: target.session.label })}
          </h2>
          <p className="detail__sub">
            {isCard ? target.card.cardId : target.session.sessionId.slice(0, 8)}
            {isCard && target.card.connectionId ? ` · ${target.card.connectionId}` : null}
          </p>
        </div>
        <button
          type="button"
          className="icon-btn icon-btn--quiet"
          aria-label={t(strings.close)}
          onClick={onClose}
        >
          <CloseIcon size={14} />
        </button>
      </header>

      {isCard ? (
        <div className="detail__tabs" role="tablist" aria-label={t(strings.detailViews)}>
          {(
            [
              ['capture', strings.tabCapture],
              ['raw', strings.tabRaw],
              ['activity', strings.tabActivity],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? 'is-active' : ''}
              onClick={() => setTab(id)}
            >
              {pick(label, locale)}
            </button>
          ))}
        </div>
      ) : null}

      <div className="detail__scroll">
        {isCard ? (
          <CardDetail
            card={target.card}
            tab={tab}
            readings={readings}
            historyFor={historyFor}
            sampleCount={sampleCount}
            activity={scoped}
          />
        ) : (
          <SessionDetail session={target.session} />
        )}
      </div>

      <footer className="detail__foot">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCopyDiagnostics}>
          <CopyIcon size={14} />
          {t(strings.copyDiagnostics)}
        </button>
        {isCard ? (
          <button
            type="button"
            className="btn btn--danger btn--sm"
            onClick={() => onRemoveCard(target.card)}
          >
            {t(strings.removeCard)}
          </button>
        ) : null}
      </footer>
    </aside>
  );
}

function useActivityScope(target: DetailTarget, activity: ActivityEntry[]): ActivityEntry[] {
  return useMemo(() => {
    if (target === null) return [];
    if (target.kind === 'card') {
      return activity.filter(
        (entry) =>
          entry.message.includes(target.card.cardId) ||
          entry.message.includes(target.card.instanceId.slice(0, 8)),
      );
    }
    return activity.filter((entry) => entry.message.includes(target.session.label));
  }, [activity, target]);
}

function CardDetail({
  card,
  tab,
  readings,
  historyFor,
  sampleCount,
  activity,
}: {
  card: CardInstanceInfo;
  tab: DetailTab;
  readings: TagReading[];
  historyFor: (tag: string) => readonly TagReading[];
  sampleCount: number;
  activity: ActivityEntry[];
}): JSX.Element {
  const look = cardLook(card.cardId);
  const t = useT();
  const locale = useLocale();
  const latest = useMemo(() => {
    const map = new Map<string, TagReading>();
    for (const reading of readings) map.set(reading.tag, reading);
    return map;
  }, [readings]);

  const cardTags = useMemo(() => {
    if (look.tags.length > 0) return look.tags;
    // Unknown card: the renderer has no manifest to read. Fall back to the
    // live stream so the panel still shows *something* true — and label it.
    return readings.map((reading) => reading.tag).slice(0, 6);
  }, [look.tags, readings]);

  const rawEvents = useMemo(() => {
    const events: TagReading[] = [];
    for (const tag of cardTags) events.push(...historyFor(tag));
    return events.sort((a, b) => b.at - a.at).slice(0, 30);
  }, [cardTags, historyFor]);

  return (
    <>
      <section className="detail__hero">
        <span className="detail__hero-dot" aria-hidden />
        <div>
          <p className="detail__hero-title">{pick(look.note, locale)}</p>
          <p className="detail__hero-sub">
            {card.connectionId
              ? t(strings.samplingFrom, { connection: card.connectionId })
              : t(strings.connectionNotReady)}
            {' · '}
            {look.tags.length > 0
              ? t(strings.tagCount, { count: look.tags.length })
              : t(strings.tagsNotPublished)}
          </p>
        </div>
      </section>

      {tab === 'capture' ? (
        <>
          <section className="detail__section">
            <h3 className="detail__section-title">{t(strings.captureBehaviour)}</h3>
            {look.tags.length === 0 ? (
              <p className="detail__empty">{t(strings.unknownCard)}</p>
            ) : null}
            <ul className="detail__tags">
              {cardTags.map((tag) => {
                const reading = latest.get(tag);
                const cadence = observedCadence(historyFor(tag));
                return (
                  <li key={tag} className="detail__tag">
                    <span className={`detail__tag-dot is-${reading?.status ?? 'unknown'}`} aria-hidden />
                    <span className="detail__tag-name mono" title={tag}>
                      {tag}
                    </span>
                    <span className={`detail__tag-value${reading ? ` is-${reading.status}` : ''}`}>
                      {reading ? formatReading(reading, locale) : '—'}
                    </span>
                    <span className="detail__tag-meta">
                      {reading ? statusLabel(reading, locale) : t(strings.notSampled)}
                      {reading ? ` · ${ageText(reading.at, locale)}` : ''}
                      {cadence === null ? '' : ` · ${cadence}`}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="detail__hint">{t(strings.observed, { count: sampleCount })}</p>
          </section>

          <section className="detail__section">
            <h3 className="detail__section-title">{t(strings.instance)}</h3>
            <dl className="kv kv--compact">
              <dt>{t(strings.connection)}</dt>
              <dd className="mono">{card.connectionId ?? t(strings.notConnected)}</dd>
              <dt>{t(strings.instance)}</dt>
              <dd className="mono">{card.instanceId.slice(0, 12)}</dd>
              <dt>{t(strings.layout)}</dt>
              <dd className="mono">
                {card.layout ? `${card.layout.w} × ${card.layout.h}` : '—'}
              </dd>
              <dt>{t(strings.state)}</dt>
              <dd>{card.degraded ? t(strings.degradedRun) : t(strings.healthy)}</dd>
            </dl>
          </section>

          <section className="detail__section">
            <h3 className="detail__section-title">{t(strings.sandbox)}</h3>
            <div className="sandbox-grid">
              <span className="sandbox-pill">sandbox=&quot;allow-scripts&quot;</span>
              <span className="sandbox-pill">opaque origin</span>
              <span className="sandbox-pill">CSP · connect-src none</span>
              <span className="sandbox-pill">{t(strings.storageHosted)}</span>
            </div>
          </section>
        </>
      ) : null}

      {tab === 'raw' ? (
        <>
          <section className="detail__section">
            <h3 className="detail__section-title">
              {t(strings.latestRaw)}{' '}
              <span>{t(strings.tagCountLabel, { count: cardTags.length })}</span>
            </h3>
            <pre className="detail__json">
              {JSON.stringify(
                Object.fromEntries(
                  cardTags.map((tag) => [tag, latest.get(tag) ?? null]),
                ),
                null,
                2,
              )}
            </pre>
          </section>

          <section className="detail__section">
            <h3 className="detail__section-title">
              {t(strings.sampleStream)}{' '}
              <span>{t(strings.entryCount, { count: rawEvents.length })}</span>
            </h3>
            {rawEvents.length === 0 ? (
              <p className="detail__empty">{t(strings.noSamples)}</p>
            ) : (
              <ul className="detail__events">
                {rawEvents.map((reading) => (
                  <li key={`${reading.tag}:${reading.seq}:${reading.at}`} className="detail__event">
                    <time className="mono">{clock(reading.at)}</time>
                    <span className={`detail__event-status is-${reading.status}`}>
                      {statusLabel(reading, locale)}
                    </span>
                    <span className="detail__event-tag mono" title={reading.tag}>
                      {reading.tag}
                    </span>
                    <span className="detail__event-value">{formatReading(reading, locale)}</span>
                    <span className="detail__event-seq mono">#{reading.seq}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="detail__hint">{t(strings.streamHint)}</p>
          </section>
        </>
      ) : null}

      {tab === 'activity' ? (
        <section className="detail__section">
          <h3 className="detail__section-title">
            {t(strings.activity)} <span>{activity.length}</span>
          </h3>
          {activity.length === 0 ? (
            <p className="detail__empty">{t(strings.noActivity)}</p>
          ) : (
            <ul className="detail__activity">
              {activity.slice(0, 20).map((entry) => (
                <li key={entry.id} className={`detail__activity-row is-${entry.level}`}>
                  <span className={`live-dot live-dot--${dotTone(entry.level)}`} aria-hidden />
                  <span className="detail__activity-text">{entry.message}</span>
                  <time className="mono">{clock(entry.at)}</time>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </>
  );
}

/** "2.0s" / "500ms" — the median gap between the last few samples. */
function observedCadence(history: readonly TagReading[]): string | null {
  const recent = history.slice(-6);
  if (recent.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < recent.length; i += 1) {
    const gap = recent[i]!.at - recent[i - 1]!.at;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)]!;
  return median >= 1000 ? `${(median / 1000).toFixed(1)}s` : `${Math.round(median)}ms`;
}

/** The raw value, formatted for a human but without the five-state paint. */
export function formatReading(reading: TagReading, locale: Locale): string {
  if (reading.value === null) return '—';
  if (typeof reading.value === 'boolean') {
    return reading.value ? pick(strings.booleanOn, locale) : pick(strings.booleanOff, locale);
  }
  if (typeof reading.value === 'string') return reading.value;
  const value = reading.value;
  switch (reading.unit) {
    case 'percent':
      return `${value.toFixed(1)}%`;
    case 'celsius':
      return `${value.toFixed(1)} °C`;
    case 'hertz': {
      if (value >= 1e9) return `${(value / 1e9).toFixed(2)} GHz`;
      if (value >= 1e6) return `${(value / 1e6).toFixed(0)} MHz`;
      return `${value.toFixed(0)} Hz`;
    }
    case 'byte': {
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
      let scaled = value;
      let index = 0;
      while (scaled >= 1024 && index < units.length - 1) {
        scaled /= 1024;
        index += 1;
      }
      return `${scaled.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
    }
    default:
      return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
}

function statusLabel(reading: TagReading, locale: Locale): string {
  switch (reading.status) {
    case 'ok':
      return pick(strings.statusOk, locale);
    case 'stale':
      return pick(strings.statusStale, locale);
    case 'unavailable':
      return pick(strings.statusUnavailable, locale);
    case 'error':
      return pick(strings.statusError, locale);
    default:
      return pick(strings.statusWaiting, locale);
  }
}

function ageText(at: number, locale: Locale): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 2) return pick(strings.justNow, locale);
  if (seconds < 60) return interpolate(pick(strings.secondsAgo, locale), { seconds });
  return interpolate(pick(strings.minutesAgo, locale), {
    minutes: Math.floor(seconds / 60),
  });
}

function clock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(
    date.getSeconds(),
  ).padStart(2, '0')}`;
}

function SessionDetail({
  session,
}: {
  session: { sessionId: string; profileId: string; label: string };
}): JSX.Element {
  const t = useT();
  return (
    <section className="detail__section">
      <h3 className="detail__section-title">{t(strings.session)}</h3>
      <dl className="kv kv--compact">
        <dt>{t(strings.name)}</dt>
        <dd>{session.label}</dd>
        <dt>{t(strings.connectionId)}</dt>
        <dd className="mono">{session.profileId}</dd>
        <dt>{t(strings.session)}</dt>
        <dd className="mono">{session.sessionId.slice(0, 12)}</dd>
      </dl>
    </section>
  );
}

function dotTone(level: 'info' | 'warn' | 'error'): 'ok' | 'warn' | 'danger' {
  if (level === 'error') return 'danger';
  if (level === 'warn') return 'warn';
  return 'ok';
}

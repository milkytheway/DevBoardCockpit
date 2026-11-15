import { useCallback, useMemo, useState } from 'react';
import type { CardInstanceInfo } from '../../../shared/ipc-contract';
import type { TagReading } from '../../../shared/tag-reading';
import { cardLook } from '../cards';
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

  if (target === null) return null;

  const isCard = target.kind === 'card';
  const look = isCard ? cardLook(target.card.cardId) : null;

  return (
    <aside className="detail" style={{ width }} aria-label="详情">
      <div className="detail__resize" onPointerDown={startResize} title="拖动调整宽度" />
      <header className="detail__head">
        <div className="detail__heading">
          <span className="detail__eyebrow">{isCard ? 'CARD INSTANCE' : 'TERMINAL SESSION'}</span>
          <h2 className="detail__title">
            {isCard ? look?.name : `终端 · ${target.session.label}`}
          </h2>
          <p className="detail__sub">
            {isCard ? target.card.cardId : target.session.sessionId.slice(0, 8)}
            {isCard && target.card.connectionId ? ` · ${target.card.connectionId}` : null}
          </p>
        </div>
        <button type="button" className="icon-btn icon-btn--quiet" aria-label="关闭详情" onClick={onClose}>
          <CloseIcon size={14} />
        </button>
      </header>

      {isCard ? (
        <div className="detail__tabs" role="tablist" aria-label="详情视图">
          {(
            [
              ['capture', '采集'],
              ['raw', '原始读数'],
              ['activity', '活动'],
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
              {label}
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
          复制诊断
        </button>
        {isCard ? (
          <button
            type="button"
            className="btn btn--danger btn--sm"
            onClick={() => onRemoveCard(target.card)}
          >
            从主区拿走
          </button>
        ) : (
          <span className="detail__foot-hint">会话由二级栏管理</span>
        )}
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
          <p className="detail__hero-title">{look.note}</p>
          <p className="detail__hero-sub">
            {card.connectionId ? `采样来自 ${card.connectionId}` : '当前连接未就绪'} ·
            {' '}
            {look.tags.length > 0 ? `${look.tags.length} 个位号` : '位号清单未公开'}
          </p>
        </div>
      </section>

      {tab === 'capture' ? (
        <>
          <section className="detail__section">
            <h3 className="detail__section-title">采集行为</h3>
            {look.tags.length === 0 ? (
              <p className="detail__empty">
                这张卡不在内置映射里：宿主只把卡片文件交给 iframe，不向 renderer 暴露 manifest。
                下面展示的是宿主公开的实时 tag 流，按最近一次采样排序。
              </p>
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
                      {reading ? formatReading(reading) : '—'}
                    </span>
                    <span className="detail__tag-meta">
                      {reading ? statusLabel(reading) : '未采样'}
                      {reading ? ` · ${ageText(reading.at)}` : ''}
                      {cadence === null ? '' : ` · ${cadence}`}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="detail__hint">
              观测到 {sampleCount} 次采样 · 原始值来自 TagStore，卡片内的显示是它自己的加工
            </p>
          </section>

          <section className="detail__section">
            <h3 className="detail__section-title">实例</h3>
            <dl className="kv kv--compact">
              <dt>连接</dt>
              <dd className="mono">{card.connectionId ?? '未连接'}</dd>
              <dt>实例</dt>
              <dd className="mono">{card.instanceId.slice(0, 12)}</dd>
              <dt>布局</dt>
              <dd className="mono">
                {card.layout ? `${card.layout.w} × ${card.layout.h}` : '—'}
              </dd>
              <dt>状态</dt>
              <dd>{card.degraded ? '降级运行（manifest 有错）' : '正常'}</dd>
            </dl>
          </section>

          <section className="detail__section">
            <h3 className="detail__section-title">沙箱</h3>
            <div className="sandbox-grid">
              <span className="sandbox-pill">sandbox=&quot;allow-scripts&quot;</span>
              <span className="sandbox-pill">opaque origin</span>
              <span className="sandbox-pill">CSP · connect-src none</span>
              <span className="sandbox-pill">存储 · 宿主代管</span>
            </div>
          </section>
        </>
      ) : null}

      {tab === 'raw' ? (
        <>
          <section className="detail__section">
            <h3 className="detail__section-title">
              最新原始值 <span>{cardTags.length} 个 tag</span>
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
              采样流水 <span>{rawEvents.length} 条</span>
            </h3>
            {rawEvents.length === 0 ? (
              <p className="detail__empty">还没有采样。等运行时连上，这里会按时间倒序长出来。</p>
            ) : (
              <ul className="detail__events">
                {rawEvents.map((reading) => (
                  <li key={`${reading.tag}:${reading.seq}:${reading.at}`} className="detail__event">
                    <time className="mono">{clock(reading.at)}</time>
                    <span className={`detail__event-status is-${reading.status}`}>
                      {statusLabel(reading)}
                    </span>
                    <span className="detail__event-tag mono" title={reading.tag}>
                      {reading.tag}
                    </span>
                    <span className="detail__event-value">{formatReading(reading)}</span>
                    <span className="detail__event-seq mono">#{reading.seq}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="detail__hint">
              流水是 renderer 内存里的最近样本（每 tag 最多 120 条）；宿主侧的完整历史尚没有 IPC。
            </p>
          </section>
        </>
      ) : null}

      {tab === 'activity' ? (
        <section className="detail__section">
          <h3 className="detail__section-title">
            活动 <span>{activity.length}</span>
          </h3>
          {activity.length === 0 ? (
            <p className="detail__empty">
              还没有这张卡的相关活动。宿主侧的卡片运行时日志在 M6 的日志面板里接。
            </p>
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
export function formatReading(reading: TagReading): string {
  if (reading.value === null) return '—';
  if (typeof reading.value === 'boolean') return reading.value ? '开' : '关';
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

function statusLabel(reading: TagReading): string {
  switch (reading.status) {
    case 'ok':
      return '正常';
    case 'stale':
      return '已过时';
    case 'unavailable':
      return '不可用';
    case 'error':
      return '读取失败';
    default:
      return '等待采样';
  }
}

function ageText(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 2) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  return `${Math.floor(seconds / 60)} 分钟前`;
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
  return (
    <section className="detail__section">
      <h3 className="detail__section-title">会话</h3>
      <dl className="kv kv--compact">
        <dt>名称</dt>
        <dd>{session.label}</dd>
        <dt>profile</dt>
        <dd className="mono">{session.profileId}</dd>
        <dt>会话</dt>
        <dd className="mono">{session.sessionId.slice(0, 12)}</dd>
      </dl>
      <p className="detail__hint">终端输出在终端页；这里只显示会话身份。</p>
    </section>
  );
}

function dotTone(level: 'info' | 'warn' | 'error'): 'ok' | 'warn' | 'danger' {
  if (level === 'error') return 'danger';
  if (level === 'warn') return 'warn';
  return 'ok';
}

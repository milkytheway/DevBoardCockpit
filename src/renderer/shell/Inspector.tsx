import { useEffect, useState } from 'react';
import type { CardInstanceInfo } from '../../shared/ipc-contract';
import type { TagReading } from '../../shared/tag-reading';
import { ageText, clockText, readingMeta, readingValueText, shortId } from './format';
import { CloseIcon } from './Icons';
import { StatusGlyph } from './ReadingViews';
import type { ActivityEntry } from './types';

type InspectorTab = 'overview' | 'data' | 'permissions' | 'activity';

export function Inspector({
  card,
  readings,
  activity,
  activeTag,
  onClose,
  onOpenLogs,
  onCopyDiagnostics,
}: {
  card: CardInstanceInfo;
  readings: TagReading[];
  activity: ActivityEntry[];
  activeTag: string | null;
  onClose: () => void;
  onOpenLogs: () => void;
  onCopyDiagnostics: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<InspectorTab>('overview');

  useEffect(() => {
    if (activeTag) setTab('data');
  }, [activeTag]);

  const cardActivity = activity.filter(
    (entry) => entry.message.includes(card.cardId) || entry.message.includes(shortId(card.instanceId)),
  );

  return (
    <aside className="inspector" data-testid="inspector" aria-label="卡片检查器">
      <header className="inspector__head">
        <div className="inspector__title">
          <span className="eyebrow">检查器</span>
          <strong>{card.cardId}</strong>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭检查器">
          <CloseIcon size={14} />
        </button>
      </header>

      <nav className="inspector__tabs" role="tablist">
        {(
          [
            ['overview', '概览'],
            ['data', '数据'],
            ['permissions', '权限'],
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
      </nav>

      <div className="inspector__body">
        {tab === 'overview' ? (
          <section className="inspector__section">
            <dl className="kv">
              <dt>实例</dt>
              <dd className="mono">{card.instanceId}</dd>
              <dt>卡片</dt>
              <dd>{card.cardId}</dd>
              <dt>连接</dt>
              <dd className="mono">{card.connectionId ?? '未连接（v1 单连接）'}</dd>
              <dt>入口</dt>
              <dd className="mono ellipsis" title={card.url}>
                {card.url}
              </dd>
              <dt>状态</dt>
              <dd>
                <span className={`chip chip--${card.degraded ? 'warn' : 'ok'} chip--sm`}>
                  {card.degraded ? '降级 · 有校验错误' : '校验通过'}
                </span>
              </dd>
            </dl>
            <div className="inspector__actions">
              <button type="button" className="btn btn--ghost btn--sm" onClick={onOpenLogs}>
                打开运行日志
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={onCopyDiagnostics}>
                复制诊断信息
              </button>
            </div>
          </section>
        ) : null}

        {tab === 'data' ? (
          <section className="inspector__section">
            <p className="dim inspector__note">
              宿主把 tag 读数推到页面；卡片自己拿到的是同一份数据的过滤视图。这里显示的是这个实例能看到的读数样本。
            </p>
            {readings.length === 0 ? (
              <p className="empty-note">还没有读数。</p>
            ) : (
              <ul className="inspector__readings">
                {readings.map((reading) => {
                  const meta = readingMeta(reading);
                  const value = readingValueText(reading);
                  return (
                    <li
                      key={reading.tag}
                      className={`tone-${meta.tone} ${activeTag === reading.tag ? 'is-active' : ''}`}
                    >
                      <StatusGlyph reading={reading} />
                      <span className="mono">{reading.tag}</span>
                      <span className="mono inspector__reading-value">
                        {meta.showValue ? value.value : '—'}
                        {meta.showValue && value.unit ? <small>{value.unit}</small> : null}
                      </span>
                      <span className="dim">{meta.label}</span>
                      <span className="dim mono">{meta.showValue ? clockText(reading.at) : ''}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ) : null}

        {tab === 'permissions' ? (
          <section className="inspector__section">
            <p className="dim inspector__note">
              权限过滤在 main：renderer 不判权限，只渲染宿主返回的实例信息。manifest 的 read/write 清单在 M5
              还没有通过 IPC 暴露，所以这里不猜。
            </p>
            <dl className="kv">
              <dt>读取</dt>
              <dd>由 permissions.read 过滤（宿主侧）</dd>
              <dt>写入</dt>
              <dd>由 permissions.write ∩ 已授权（宿主侧）</dd>
              <dt>降级</dt>
              <dd>{card.degraded ? '有错误，卡片仍会加载' : '无'}</dd>
            </dl>
          </section>
        ) : null}

        {tab === 'activity' ? (
          <section className="inspector__section">
            {cardActivity.length === 0 ? (
              <p className="empty-note">这个卡片还没有活动记录。</p>
            ) : (
              <ol className="activity-list activity-list--narrow">
                {cardActivity.map((entry) => (
                  <li key={entry.id} className={`activity-list__item tone-${entry.level}`}>
                    <span className="mono activity-list__time">{clockText(entry.at)}</span>
                    <span className="activity-list__message">{entry.message}</span>
                    <span className="dim activity-list__age">{ageText(entry.at)}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        ) : null}
      </div>
    </aside>
  );
}

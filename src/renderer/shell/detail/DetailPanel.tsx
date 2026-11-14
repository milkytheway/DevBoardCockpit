import { useCallback } from 'react';
import type { CardInstanceInfo } from '../../../shared/ipc-contract';
import { cardLook, cardToneVar } from '../cards';
import { CloseIcon, CopyIcon } from '../Icons';
import type { ActivityEntry, DetailTarget } from '../types';

/**
 * The right-hand detail panel.
 *
 * It is a **panel**, not a page: it appears when a card (or a session) is
 * selected and can be dragged wider from its left edge. Everything in it is
 * about the *instance* — the card's own readings stay inside the card.
 */
export function DetailPanel({
  target,
  width,
  activity,
  onWidthChange,
  onClose,
  onCopyDiagnostics,
  onRemoveCard,
}: {
  target: DetailTarget;
  width: number;
  activity: ActivityEntry[];
  onWidthChange: (width: number) => void;
  onClose: () => void;
  onCopyDiagnostics: () => void;
  onRemoveCard: (card: CardInstanceInfo) => void;
}): JSX.Element | null {
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

  if (target === null) return null;

  const isCard = target.kind === 'card';
  const look = isCard ? cardLook(target.card.cardId) : null;
  const scoped =
    target.kind === 'card'
      ? activity.filter(
          (entry) =>
            entry.message.includes(target.card.cardId) ||
            entry.message.includes(target.card.instanceId.slice(0, 8)),
        )
      : activity.filter((entry) => entry.message.includes(target.session.label));

  return (
    <aside className="detail" style={{ width }} aria-label="详情">
      <div className="detail__resize" onPointerDown={startResize} title="拖动调整宽度" />
      <header className={`detail__head${look ? ` detail__head--${look.tone}` : ''}`}>
        <div className="detail__heading">
          <span className="detail__eyebrow">{isCard ? 'CARD INSTANCE' : 'TERMINAL SESSION'}</span>
          <h2 className="detail__title">
            {isCard ? look?.name : `终端 · ${target.session.label}`}
          </h2>
          <p className="detail__sub">
            {isCard ? target.card.cardId : target.session.sessionId.slice(0, 8)}
          </p>
        </div>
        <button type="button" className="icon-btn icon-btn--quiet" aria-label="关闭详情" onClick={onClose}>
          <CloseIcon size={14} />
        </button>
      </header>

      <div className="detail__scroll">
        {isCard ? <CardDetail card={target.card} /> : <SessionDetail session={target.session} />}

        <section className="detail__section">
          <h3 className="detail__section-title">
            活动 <span>{scoped.length}</span>
          </h3>
          {scoped.length === 0 ? (
            <p className="detail__empty">还没有这张卡的活动。</p>
          ) : (
            <ul className="detail__activity">
              {scoped.slice(0, 8).map((entry) => (
                <li key={entry.id} className={`detail__activity-row is-${entry.level}`}>
                  <span className={`live-dot live-dot--${dotTone(entry.level)}`} aria-hidden />
                  <span className="detail__activity-text">{entry.message}</span>
                  <time className="mono">{new Date(entry.at).toLocaleTimeString()}</time>
                </li>
              ))}
            </ul>
          )}
        </section>
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

function CardDetail({ card }: { card: CardInstanceInfo }): JSX.Element {
  const look = cardLook(card.cardId);
  const tone = cardToneVar(look.tone);
  return (
    <>
      <section className="detail__hero" style={{ '--card-tone': tone } as React.CSSProperties}>
        <span className="detail__hero-dot" aria-hidden />
        <div>
          <p className="detail__hero-title">{look.note}</p>
          <p className="detail__hero-sub">
            运行在独立沙箱 iframe 里 · 只能经白名单 API 访问宿主
          </p>
        </div>
      </section>

      <section className="detail__section">
        <h3 className="detail__section-title">实例</h3>
        <dl className="kv kv--compact">
          <dt>连接</dt>
          <dd className="mono">{card.connectionId ?? '未连接'}</dd>
          <dt>实例</dt>
          <dd className="mono">{card.instanceId.slice(0, 12)}</dd>
          <dt>状态</dt>
          <dd>{card.degraded ? '降级运行（manifest 有错）' : '正常'}</dd>
          <dt>权限</dt>
          <dd>由 manifest 声明 · 主进程逐次过滤</dd>
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

      <section className="detail__section">
        <h3 className="detail__section-title">入口</h3>
        <p className="mono detail__url">{card.url}</p>
      </section>
    </>
  );
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
    </section>
  );
}

function dotTone(level: 'info' | 'warn' | 'error'): 'ok' | 'warn' | 'danger' {
  if (level === 'error') return 'danger';
  if (level === 'warn') return 'warn';
  return 'ok';
}

import type { CardInstanceInfo } from '../../../shared/ipc-contract';
import type { ActivityEntry, DetailTarget } from '../types';

/**
 * The right-hand detail panel: what you get when you click a card.
 *
 * ── it is a **panel**, not a page ──
 *
 * It appears when something is selected and disappears when nothing is.
 * There is no "inspector" mode and no separate navigation step: click a
 * card, read its details, click elsewhere, it is gone.
 *
 * ── no readings here ──
 *
 * Readings belong to the cards: each card subscribes to the tags it may
 * read and renders them itself. The host shows the **instance** facts —
 * which card, which instance, where it lives, what it may do.
 */
export function DetailPanel({
  target,
  activity,
  onClose,
  onCopyDiagnostics,
}: {
  target: DetailTarget;
  activity: ActivityEntry[];
  onClose: () => void;
  onCopyDiagnostics: () => void;
}): JSX.Element | null {
  if (target === null) return null;
  return (
    <aside className="detail" aria-label="详情">
      <header className="detail__head">
        <h2 className="detail__title">
          {target.kind === 'card' ? target.card.cardId : `终端 · ${target.session.label}`}
        </h2>
        <button type="button" className="icon-btn" aria-label="关闭详情" onClick={onClose}>
          ✕
        </button>
      </header>

      {target.kind === 'card' ? <CardDetail card={target.card} /> : <SessionDetail session={target.session} />}

      <section className="detail__section">
        <h3 className="detail__section-title">活动</h3>
        {activity.length === 0 ? (
          <p className="detail__empty">还没有记录。</p>
        ) : (
          <ul className="detail__activity">
            {activity.slice(0, 20).map((entry) => (
              <li key={entry.id} className={`detail__activity-row is-${entry.level}`}>
                <time className="mono">{new Date(entry.at).toLocaleTimeString()}</time>
                <span>{entry.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="detail__foot">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCopyDiagnostics}>
          复制诊断信息
        </button>
      </footer>
    </aside>
  );
}

function CardDetail({ card }: { card: CardInstanceInfo }): JSX.Element {
  return (
    <>
      <section className="detail__section">
        <h3 className="detail__section-title">实例</h3>
        <dl className="kv">
          <dt>卡片</dt>
          <dd className="mono">{card.cardId}</dd>
          <dt>实例</dt>
          <dd className="mono">{card.instanceId.slice(0, 8)}</dd>
          <dt>连接</dt>
          <dd className="mono">{card.connectionId ?? '无'}</dd>
          <dt>校验</dt>
          <dd>{card.degraded ? '降级（manifest 有错）' : '通过'}</dd>
        </dl>
      </section>

      <section className="detail__section">
        <h3 className="detail__section-title">权限</h3>
        <p className="detail__note">
          权限判定在宿主进程里，这一页**不猜**。卡片能读哪些 tag 由它自己的 manifest
          声明，主进程逐次过滤——没权限的 tag 和不存在的 tag 返回**同一个形状**。
        </p>
      </section>

      <section className="detail__section">
        <h3 className="detail__section-title">地址</h3>
        <p className="mono detail__url">{card.url}</p>
      </section>
    </>
  );
}

function SessionDetail({ session }: { session: { sessionId: string; profileId: string; label: string } }): JSX.Element {
  return (
    <section className="detail__section">
      <h3 className="detail__section-title">会话</h3>
      <dl className="kv">
        <dt>名称</dt>
        <dd>{session.label}</dd>
        <dt>profile</dt>
        <dd className="mono">{session.profileId}</dd>
        <dt>会话</dt>
        <dd className="mono">{session.sessionId.slice(0, 8)}</dd>
      </dl>
    </section>
  );
}

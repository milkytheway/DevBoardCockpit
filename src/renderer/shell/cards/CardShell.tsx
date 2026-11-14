import { useState } from 'react';
import type { CardInstanceInfo } from '../../../shared/ipc-contract';
import type { CardBroker } from '../../cards/broker';
import { UserCard } from '../../cards/user-card';

/**
 * The host-drawn chrome around one card.
 *
 * ── the host draws it, the card never can ──
 *
 * A card is an opaque origin: it cannot reach the host's DOM at all
 * (contract §6). So the title bar, the drag handle, the state chip and the
 * menu are **ours** — the card only draws inside its iframe.
 *
 * ── the drag handle is also the e2e hook ──
 *
 * `data-cockpit-drag-handle` / `data-card-id` are what the Playwright
 * layout test looks for. They live on the handle element on purpose: the
 * handle is the one thing that must not move, because it is also the
 * thing you drag.
 */
export function CardShell({
  info,
  broker,
  selected,
  onSelect,
  onOpenDetail,
  onRemove,
}: {
  info: CardInstanceInfo;
  broker: CardBroker;
  selected: boolean;
  onSelect: (info: CardInstanceInfo) => void;
  onOpenDetail: (info: CardInstanceInfo) => void;
  onRemove: (info: CardInstanceInfo) => void;
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <section
      className={`cockpit-card${selected ? ' is-selected' : ''}`}
      data-card-id={info.cardId}
      data-instance-id={info.instanceId}
    >
      <header className="cockpit-card__head">
        <div
          className="cockpit-card__handle"
          data-cockpit-drag-handle="true"
          data-card-id={info.cardId}
          onClick={() => {
            onSelect(info);
            onOpenDetail(info);
          }}
          title="拖动改变位置，单击看详情"
        >
          <span className="cockpit-card__grip" aria-hidden>
            ⠿
          </span>
          <span className="cockpit-card__titles">
            <span className="cockpit-card__title">{info.cardId}</span>
            <span className="cockpit-card__sub">
              {info.connectionId ? `${info.connectionId.slice(0, 8)} · ` : '未连接 · '}sandbox
            </span>
          </span>
        </div>
        <span className={`chip chip--${info.degraded ? 'warn' : 'ok'} chip--sm`}>
          {info.degraded ? '降级' : '就绪'}
        </span>
        <div className="card-menu">
          <button
            type="button"
            className="icon-btn"
            aria-label="卡片菜单"
            aria-expanded={menuOpen}
            title="卡片菜单"
            onClick={() => setMenuOpen((open) => !open)}
          >
            ⋯
          </button>
          {menuOpen ? (
            <div className="card-menu__pop" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenDetail(info);
                }}
              >
                查看详情
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onRemove(info);
                }}
              >
                从主区拿走
              </button>
            </div>
          ) : null}
        </div>
      </header>
      <div className="cockpit-card__body">
        <UserCard info={info} broker={broker} />
      </div>
      <footer className="cockpit-card__foot">
        <span className="glyph glyph--ok" aria-hidden>
          ●
        </span>
        <span>iframe · opaque origin</span>
        <span className="spacer" />
        <span className="mono" title={info.instanceId}>
          {info.instanceId.slice(0, 8)}
        </span>
      </footer>
    </section>
  );
}

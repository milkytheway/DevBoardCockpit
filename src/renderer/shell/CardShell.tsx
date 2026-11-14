import { useState } from 'react';
import type { CardInstanceInfo } from '../../shared/ipc-contract';
import type { CardBroker } from '../cards/broker';
import { UserCard } from '../cards/user-card';
import { shortId } from './format';

/**
 * Host-drawn chrome around one user card. The iframe is the card; this component
 * owns the title bar, the footer and the drag handle — cards can never draw these.
 */
export function CardShell({
  info,
  broker,
  selected,
  onSelect,
  onOpenInspector,
  onHide,
}: {
  info: CardInstanceInfo;
  broker: CardBroker;
  selected: boolean;
  onSelect: (info: CardInstanceInfo) => void;
  onOpenInspector: (info: CardInstanceInfo) => void;
  /** Hide this card in the *current view* only (layout, not permissions). */
  onHide: (info: CardInstanceInfo) => void;
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <section
      className={`cockpit-card ${selected ? 'is-selected' : ''}`}
      data-card-id={info.cardId}
      data-instance-id={info.instanceId}
    >
      <header className="cockpit-card__head">
        <div
          className="cockpit-card__handle"
          data-cockpit-drag-handle="true"
          data-card-id={info.cardId}
          onClick={() => onSelect(info)}
          title="拖动改变位置"
        >
          <span className="cockpit-card__grip" aria-hidden>
            ⠿
          </span>
          <span className="cockpit-card__titles">
            <span className="cockpit-card__title">{info.cardId}</span>
            <span className="cockpit-card__sub">
              {info.connectionId ? shortId(info.connectionId) : '未连接'} · sandbox
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
                  onOpenInspector(info);
                }}
              >
                打开检查器
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onHide(info);
                }}
              >
                从本视图隐藏
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
          {shortId(info.instanceId)}
        </span>
      </footer>
    </section>
  );
}

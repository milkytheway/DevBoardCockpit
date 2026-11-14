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
}: {
  info: CardInstanceInfo;
  broker: CardBroker;
  selected: boolean;
  onSelect: (info: CardInstanceInfo) => void;
  onOpenInspector: (info: CardInstanceInfo) => void;
}): JSX.Element {
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
        <button
          type="button"
          className="icon-btn"
          aria-label="打开卡片检查器"
          title="卡片检查器"
          onClick={() => onOpenInspector(info)}
        >
          ⋯
        </button>
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

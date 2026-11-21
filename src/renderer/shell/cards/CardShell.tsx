import { useEffect, useRef, useState } from 'react';
import type { CardInstanceInfo } from '../../../shared/ipc-contract';
import type { ThemeName } from '../../../shared/theme/seed';
import type { CardBroker } from '../../cards/broker';
import { UserCard } from '../../cards/user-card';
import { cardLook } from '../cards';
import { CardGlyph } from '../CardGlyph';
import { pick, useLocale, useT, type Localised } from '../i18n';


const strings = {
  degraded: { 'zh-Hans': '降级运行', en: 'degraded' },
  running: { 'zh-Hans': '运行中', en: 'running' },
  cardHandle: { 'zh-Hans': '移动卡片', en: 'Move card' },
  cardMenu: { 'zh-Hans': '卡片菜单', en: 'Card menu' },
  viewDetail: { 'zh-Hans': '查看详情', en: 'View the details' },
  removeCard: { 'zh-Hans': '从主区拿走', en: 'Take it out of the work area' },
} satisfies Record<string, Localised>;

/**
 * The host-drawn chrome around one card.
 *
 * ── the host draws it, the card never can ──
 *
 * A card is an opaque origin: it cannot reach the host's DOM at all
 * (contract §6). So the title bar, the drag handle, the state chip and the
 * menu are **ours** — the card only draws inside its iframe.
 *
 * ── dragging and clicking share one element ──
 *
 * The whole title bar is the drag handle (react-grid-layout's
 * `draggableHandle`), and it is also the "open the detail panel" target.
 * react-grid-layout's drag routine swallows the `click` event, so the click
 * is detected here from the pointer travel: down and up within a few pixels
 * means a click, anything further means a drag.
 *
 * `data-cockpit-drag-handle` / `data-card-id` are the e2e hooks the layout
 * test looks for, and they must stay on this element.
 */
export function CardShell({
  info,
  broker,
  theme,
  selected,
  onSelect,
  onOpenDetail,
  onRemove,
}: {
  info: CardInstanceInfo;
  broker: CardBroker;
  theme: ThemeName;
  selected: boolean;
  onSelect: (info: CardInstanceInfo) => void;
  onOpenDetail: (info: CardInstanceInfo) => void;
  onRemove: (info: CardInstanceInfo) => void;
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const downRef = useRef<{ x: number; y: number } | null>(null);
  const look = cardLook(info.cardId);
  const t = useT();
  const locale = useLocale();

  // Close the menu when the pointer goes down anywhere else. `pointerdown`
  // (not `mousedown`) also covers touch and pen on Windows.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

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
          aria-label={`${t(strings.cardHandle)} · ${pick(look.name, locale)}`}
          onPointerDown={(event) => {
            downRef.current = { x: event.clientX, y: event.clientY };
          }}
          onPointerUp={(event) => {
            const down = downRef.current;
            downRef.current = null;
            if (down === null) return;
            const travel = Math.hypot(event.clientX - down.x, event.clientY - down.y);
            if (travel > 4) return;
            onSelect(info);
            onOpenDetail(info);
          }}
          onPointerCancel={() => {
            downRef.current = null;
          }}
        >
          <span className="cockpit-card__grip" aria-hidden>
            ⋮⋮
          </span>
          <span className="cockpit-card__icon" aria-hidden>
            <CardGlyph icon={look.icon} size={16} />
          </span>
          <span className="cockpit-card__titles">
            <span className="cockpit-card__title">{pick(look.name, locale)}</span>
          </span>
        </div>
        <span
          className={`state-chip state-chip--dot${info.degraded ? ' state-chip--warn' : ' state-chip--ok'}`}
          title={info.degraded ? pick(strings.degraded, locale) : pick(strings.running, locale)}
          aria-label={info.degraded ? pick(strings.degraded, locale) : pick(strings.running, locale)}
        >
          <span className={`live-dot live-dot--${info.degraded ? 'warn' : 'ok'}`} aria-hidden />
        </span>
        <div className="card-menu" ref={menuRef}>
          <button
            type="button"
            className="icon-btn icon-btn--quiet"
            aria-label={t(strings.cardMenu)}
            aria-expanded={menuOpen}
            title={t(strings.cardMenu)}
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
                {t(strings.viewDetail)}
              </button>
              <button
                type="button"
                role="menuitem"
                className="is-danger"
                onClick={() => {
                  setMenuOpen(false);
                  onRemove(info);
                }}
              >
                {t(strings.removeCard)}
              </button>
            </div>
          ) : null}
        </div>
      </header>
      {/*
        The iframe gets its theme tokens injected by the protocol handler when
        the document loads. A theme switch therefore remounts the frame (key =
        theme) so the next request carries the new tokens; the card itself is
        stateless and re-subscribes through the broker.
      */}
      <div className="cockpit-card__body" key={theme}>
        <UserCard info={info} broker={broker} />
      </div>
    </section>
  );
}

import { useEffect, useState } from 'react';
import {
  ChevronIcon,
  FolderIcon,
  GearIcon,
  GridIcon,
  LayersIcon,
  ListIcon,
  MinusIcon,
  PlusIcon,
  TerminalIcon,
} from './Icons';
import { CardGlyph } from './CardGlyph';
import { cardToneVar } from './cards';
import type { SecondaryGroup, SecondaryItem } from './nav';
import { pick, useLocale, useT, type Localised } from './i18n';

const STORAGE_KEY = 'devboard.collapsedSections';

function readCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

export interface SecondaryStatus {
  label: Localised;
  detail: Localised;
  tone: 'ok' | 'warn' | 'danger' | 'muted';
}

/**
 * The secondary sidebar: the options for the page you are on.
 *
 * ── the status lives in the header now ──
 *
 * The board state used to be its own block at the top of the list, which cost
 * a scroll row on every page. It is now one line next to the page title:
 * "Workbench · sampling". The list starts with the cards, which is what the page is
 * actually for.
 *
 * ── semantic group headings collapse ──
 *
 * Pinned and each card family are separate groups; clicking a heading folds
 * that group. The folded set is remembered in localStorage, so the sidebar
 * keeps the shape the user left it in.
 */
const strings = {
  collapse: { 'zh-Hans': '收起二级栏', en: 'Collapse the secondary sidebar' },
  expand: { 'zh-Hans': '展开', en: 'Expand' },
  noOptions: { 'zh-Hans': '没有可选项', en: 'Nothing to choose from' },
  workArea: { 'zh-Hans': '主区', en: 'Work area' },
  pin: { 'zh-Hans': '置顶 {name}', en: 'Pin {name}' },
  unpin: { 'zh-Hans': '取消置顶 {name}', en: 'Unpin {name}' },
  pinShort: { 'zh-Hans': '置顶', en: 'Pin' },
  unpinShort: { 'zh-Hans': '取消置顶', en: 'Unpin' },
  close: { 'zh-Hans': '关闭 {name}', en: 'Close {name}' },
  closeSession: { 'zh-Hans': '关闭会话', en: 'Close the session' },
  pageOptions: { 'zh-Hans': '页面选项', en: 'Page options' },
};

export function Secondary({
  title,
  status,
  groups,
  onCollapse,
}: {
  title: Localised;
  status: SecondaryStatus;
  groups: SecondaryGroup[];
  onCollapse: () => void;
}): JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const t = useT();
  const locale = useLocale();

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...collapsed]));
    } catch {
      // memory-only sidebar still works
    }
  }, [collapsed]);

  const toggle = (key: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <aside className="secondary" aria-label={t(strings.pageOptions)}>
      <header className="secondary__head">
        <div className="secondary__heading">
          <h2 className="secondary__page">{pick(title, locale)}</h2>
          <span
            className={`secondary__status secondary__status--${status.tone}`}
            title={`${pick(status.label, locale)} · ${pick(status.detail, locale)}`}
          >
            <span className={`live-dot live-dot--${status.tone}`} aria-hidden />
            <span className="secondary__status-label">{pick(status.label, locale)}</span>
            <span className="secondary__status-detail">{pick(status.detail, locale)}</span>
          </span>
        </div>
        <button
          type="button"
          className="icon-btn icon-btn--quiet"
          onClick={onCollapse}
          title={t(strings.collapse)}
          aria-label={t(strings.collapse)}
        >
          <ChevronIcon size={14} />
        </button>
      </header>

      <div className="secondary__scroll">
        {groups.map((group) => {
          const groupKey = `group:${group.id}`;
          const groupCollapsed = collapsed.has(groupKey);
          return (
            <section key={group.id} className={`secondary__group secondary__group--${group.id}`}>
              <button
                type="button"
                className="secondary__title"
                onClick={() => toggle(groupKey)}
                aria-expanded={!groupCollapsed}
                title={groupCollapsed ? t(strings.expand) : t(strings.collapse)}
              >
                <ChevronIcon
                  size={12}
                  className={groupCollapsed ? 'is-collapsed' : undefined}
                />
                <span>{pick(group.title, locale)}</span>
                <span className="secondary__count">{group.items.length}</span>
              </button>
              {groupCollapsed ? null : group.items.length === 0 ? (
                <p className="secondary__empty">{t(strings.noOptions)}</p>
              ) : (
                <ul className="secondary__list">
                  {group.items.map((item) => (
                    <li key={item.id} className="secondary__row">
                          <button
                            type="button"
                            className={`secondary__item${item.tone === 'active' ? ' is-active' : ''}${
                              item.tone === 'muted' ? ' is-muted' : ''
                            }${item.cardId !== undefined ? ' is-card' : ''}`}
                            // **A stable e2e hook** (not a class name — the shell's DOM may be replaced wholesale)
                            data-cockpit-card-id={item.cardId}
                            data-cockpit-session-id={item.sessionId}
                            onClick={item.onSelect}
                            style={cardToneStyle(item)}
                          >
                            <span className="secondary__row-icon" aria-hidden>
                              {item.cardIcon ? (
                                <CardGlyph icon={item.cardIcon} size={14} />
                              ) : (
                                iconFor(group.id)
                              )}
                            </span>
                            <span className="secondary__text">
                              <span className="secondary__label-row">
                                <span className="secondary__label">
                                  {pick(item.label, locale)}
                                </span>
                              </span>
                              {item.hint ? (
                                <span className="secondary__hint">
                                  {item.placed ? (
                                    <span className="secondary__placed">
                                      {t(strings.workArea)}
                                    </span>
                                  ) : null}
                                  {pick(item.hint, locale)}
                                </span>
                              ) : null}
                            </span>
                            {item.cardId !== undefined ? (
                              <span
                                className={`secondary__card-action${
                                  item.placed ? ' is-remove' : ' is-add'
                                }`}
                                aria-hidden
                              >
                                {item.placed ? <MinusIcon size={12} /> : <PlusIcon size={12} />}
                              </span>
                            ) : null}
                            {item.badge ? <span className="secondary__badge">{item.badge}</span> : null}
                          </button>
                          {item.onPin ? (
                            <button
                              type="button"
                              className={`secondary__pin${item.pinned ? ' is-pinned' : ''}`}
                              aria-label={
                                item.pinned
                                  ? t(strings.unpin, { name: pick(item.label, locale) })
                                  : t(strings.pin, { name: pick(item.label, locale) })
                              }
                              title={item.pinned ? t(strings.unpinShort) : t(strings.pinShort)}
                              onClick={item.onPin}
                            >
                              {item.pinned ? '★' : '☆'}
                            </button>
                          ) : null}
                          {item.onClose ? (
                            <button
                              type="button"
                              className="secondary__close"
                              aria-label={t(strings.close, { name: pick(item.label, locale) })}
                              title={t(strings.closeSession)}
                              // **Outside the row button**: clicking it must not select the row as well
                              onClick={item.onClose}
                            >
                              ✕
                            </button>
                          ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function iconFor(groupId: string): JSX.Element {
  switch (groupId) {
    case 'cards':
    case 'library':
      return <LayersIcon size={14} />;
    case 'connections':
      return <TerminalIcon size={14} />;
    case 'sessions':
      return <FolderIcon size={14} />;
    case 'filter':
      return <ListIcon size={14} />;
    case 'settings':
      return <GearIcon size={14} />;
    default:
      // → **The groups that are named after a board** ✓ (`connections:atk-01` ✓
      //   · `sessions:fake-board` ✓) → the terminal pictogram ✓ (they are
      //   connections and sessions ✓).
      if (groupId.startsWith('connections:') || groupId.startsWith('sessions:')) {
        return <TerminalIcon size={14} />;
      }
      return <GridIcon size={14} />;
  }
}

/** Give a card row its family tint; non-card rows get no inline variable. */
function cardToneStyle(item: SecondaryItem): React.CSSProperties | undefined {
  if (item.cardTone === undefined) return undefined;
  return { '--card-tone': cardToneVar(item.cardTone) } as React.CSSProperties;
}

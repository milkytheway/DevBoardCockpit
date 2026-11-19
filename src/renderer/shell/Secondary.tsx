import { Fragment, useEffect, useState } from 'react';
import {
  ChevronIcon,
  FolderIcon,
  GearIcon,
  GridIcon,
  LayersIcon,
  ListIcon,
  TerminalIcon,
} from './Icons';
import { CardGlyph } from './CardGlyph';
import { cardToneVar } from './cards';
import type { SecondaryGroup, SecondaryItem } from './nav';
import { pick, useLocale, useT } from './i18n';

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
  label: string;
  detail: string;
  tone: 'ok' | 'warn' | 'danger' | 'muted';
}

/**
 * The secondary sidebar: the options for the page you are on.
 *
 * ── the status lives in the header now ──
 *
 * The board state used to be its own block at the top of the list, which cost
 * a scroll row on every page. It is now one line next to the page title:
 * "工作台 · 采样中". The list starts with the cards, which is what the page is
 * actually for.
 *
 * ── section headings collapse ──
 *
 * Pinned and each card family are separate sections; clicking a heading folds
 * it. The folded set is remembered in localStorage, so the sidebar keeps the
 * shape the user left it in.
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
  expandNamed: { 'zh-Hans': '展开 {name}', en: 'Expand {name}' },
  collapseNamed: { 'zh-Hans': '折叠 {name}', en: 'Collapse {name}' },
  pinned: { 'zh-Hans': '置顶', en: 'Pinned' },
};

export function Secondary({
  title,
  status,
  groups,
  onCollapse,
}: {
  title: string;
  status: SecondaryStatus;
  groups: SecondaryGroup[];
  onCollapse: () => void;
}): JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const t = useT();
  const locale = useLocale();
  const pinnedLabel = '置顶';

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
    <aside className="secondary" aria-label="页面选项">
      <header className="secondary__head">
        <div className="secondary__heading">
          <h2 className="secondary__page">{title}</h2>
          <span
            className={`secondary__status secondary__status--${status.tone}`}
            title={`${status.label} · ${status.detail}`}
          >
            <span className={`live-dot live-dot--${status.tone}`} aria-hidden />
            <span className="secondary__status-label">{status.label}</span>
            <span className="secondary__status-detail">{status.detail}</span>
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
                  {group.items.map((item, index) => {
                    const previous = group.items[index - 1];
                    const showSection =
                      item.section !== undefined && item.section !== previous?.section;
                    const sectionKey = `${group.id}:${item.section?.['zh-Hans'] ?? ''}`;
                    const sectionCollapsed = collapsed.has(`section:${sectionKey}`);
                    // A section hides **all of its rows**; the heading stays so
                    // the group can be reopened. `item.section` is contiguous
                    // (nav.ts sorts by it), so this only checks the current one.
                    if (item.section !== undefined && sectionCollapsed) {
                      return showSection ? (
                        <li key={`${item.id}-heading`} className="secondary__section">
                          <SectionHeading
                            label={pick(item.section, locale)}
                            pinned={item.section?.['zh-Hans'] === pinnedLabel}
                            collapsed
                            onToggle={() => toggle(`section:${sectionKey}`)}
                          />
                        </li>
                      ) : null;
                    }
                    return (
                      <Fragment key={item.id}>
                        {showSection ? (
                          <li className="secondary__section">
                            <SectionHeading
                              label={pick(item.section, locale)}
                              pinned={item.section?.['zh-Hans'] === pinnedLabel}
                              collapsed={false}
                              onToggle={() => toggle(`section:${sectionKey}`)}
                            />
                          </li>
                        ) : null}
                        <li className="secondary__row">
                          <button
                            type="button"
                            className={`secondary__item${item.tone === 'active' ? ' is-active' : ''}${
                              item.tone === 'muted' ? ' is-muted' : ''
                            }${item.cardId !== undefined ? ' is-card' : ''}`}
                            // **稳定的 e2e 钩子**（不认 class 名 —— 外壳的 DOM 可以整个换掉）
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
                              // **在行按钮外面**：点它不该顺手选中那一行
                              onClick={item.onClose}
                            >
                              ✕
                            </button>
                          ) : null}
                        </li>
                      </Fragment>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function SectionHeading({
  label,
  pinned,
  collapsed,
  onToggle,
}: {
  label: string;
  pinned: boolean;
  collapsed: boolean;
  onToggle: () => void;
}): JSX.Element {
  const t = useT();
  return (
    <button
      type="button"
      className="secondary__section-toggle"
      onClick={onToggle}
      aria-expanded={!collapsed}
      title={collapsed ? t(strings.expandNamed, { name: label }) : t(strings.collapseNamed, { name: label })}
    >
      <ChevronIcon size={11} className={collapsed ? 'is-collapsed' : undefined} />
      <span>{label}</span>
      {pinned ? <span className="secondary__section-hint">{t(strings.pinned)}</span> : null}
    </button>
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
      return <GridIcon size={14} />;
  }
}

/** Give a card row its family tint; non-card rows get no inline variable. */
function cardToneStyle(item: SecondaryItem): React.CSSProperties | undefined {
  if (item.cardTone === undefined) return undefined;
  return { '--card-tone': cardToneVar(item.cardTone) } as React.CSSProperties;
}

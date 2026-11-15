import { Fragment } from 'react';
import {
  ChevronIcon,
  FolderIcon,
  GearIcon,
  GridIcon,
  LayersIcon,
  ListIcon,
  TerminalIcon,
} from './Icons';
import type { SecondaryGroup, SecondaryItem } from './nav';

/**
 * The secondary sidebar: the options for the page you are on.
 *
 * ── one renderer, six pages ──
 *
 * The content comes from `nav.ts` as data; this component only draws it.
 * A page title and a collapse control live at the top so the sidebar can be
 * folded away when the cards need the whole window.
 */
export function Secondary({
  title,
  groups,
  onCollapse,
}: {
  title: string;
  groups: SecondaryGroup[];
  onCollapse: () => void;
}): JSX.Element {
  return (
    <aside className="secondary" aria-label="页面选项">
      <header className="secondary__head">
        <div className="secondary__heading">
          <span className="secondary__eyebrow">SIDEBAR</span>
          <h2 className="secondary__page">{title}</h2>
        </div>
        <button
          type="button"
          className="icon-btn icon-btn--quiet"
          onClick={onCollapse}
          title="收起二级栏"
          aria-label="收起二级栏"
        >
          <ChevronIcon size={14} />
        </button>
      </header>

      <div className="secondary__scroll">
        {groups.map((group) => (
          <section key={group.id} className={`secondary__group secondary__group--${group.id}`}>
            <h3 className="secondary__title">
              <span>{group.title}</span>
              {group.id !== 'status' ? (
                <span className="secondary__count">{group.items.length}</span>
              ) : null}
            </h3>
            {group.items.length === 0 ? (
              <p className="secondary__empty">没有可选项</p>
            ) : (
              <ul className="secondary__list">
                {group.items.map((item, index) => {
                  const previous = group.items[index - 1];
                  const showSection =
                    item.section !== undefined && item.section !== previous?.section;
                  return (
                    <Fragment key={item.id}>
                      {showSection ? (
                        <li className="secondary__section" role="presentation">
                          <span>{item.section}</span>
                          {item.section === 'Pinned' ? (
                            <span className="secondary__section-hint">置顶</span>
                          ) : null}
                        </li>
                      ) : null}
                      <li className="secondary__row">
                        <button
                          type="button"
                          className={`secondary__item${item.tone === 'active' ? ' is-active' : ''}${
                            item.tone === 'muted' ? ' is-muted' : ''
                          }`}
                          // **稳定的 e2e 钩子**（不认 class 名 —— 外壳的 DOM 可以整个换掉）
                          data-cockpit-card-id={item.cardId}
                          data-cockpit-session-id={item.sessionId}
                          onClick={item.onSelect}
                        >
                          <span className="secondary__row-icon" aria-hidden>
                            {iconFor(group.id, item)}
                          </span>
                          <span className="secondary__text">
                            <span className="secondary__label">{item.label}</span>
                            {item.hint ? <span className="secondary__hint">{item.hint}</span> : null}
                          </span>
                          {item.badge ? <span className="secondary__badge">{item.badge}</span> : null}
                        </button>
                        {item.onPin ? (
                          <button
                            type="button"
                            className={`secondary__pin${item.pinned ? ' is-pinned' : ''}`}
                            aria-label={item.pinned ? `取消置顶 ${item.label}` : `置顶 ${item.label}`}
                            title={item.pinned ? '取消置顶' : '置顶'}
                            onClick={item.onPin}
                          >
                            {item.pinned ? '★' : '☆'}
                          </button>
                        ) : null}
                        {item.onClose ? (
                          <button
                            type="button"
                            className="secondary__close"
                            aria-label={`关闭 ${item.label}`}
                            title="关闭会话"
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
        ))}
      </div>
    </aside>
  );
}

function iconFor(groupId: string, item: SecondaryItem): JSX.Element {
  switch (groupId) {
    case 'status':
      return <span className={`status-pip status-pip--${item.tone === 'muted' ? 'warn' : 'ok'}`} />;
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

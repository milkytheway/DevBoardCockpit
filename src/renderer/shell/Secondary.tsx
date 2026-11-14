import type { SecondaryGroup } from './nav';

/**
 * The secondary sidebar: the options for the page you are on.
 *
 * ── one renderer, six pages ──
 *
 * The content comes from `nav.ts` as data; this component only draws it.
 * That keeps every page's sidebar consistent (same row, same selection
 * treatment, same empty state) and means a new page is a new data function
 * rather than a new component.
 */
export function Secondary({
  groups,
  emptyHint,
}: {
  groups: SecondaryGroup[];
  /** Shown when the page has nothing to list. */
  emptyHint?: string;
}): JSX.Element {
  const isEmpty = groups.every((group) => group.items.length === 0);
  return (
    <nav className="secondary" aria-label="页面选项">
      {groups.map((group) => (
        <section key={group.id} className="secondary__group">
          <h3 className="secondary__title">{group.title}</h3>
          {group.items.length === 0 ? (
            <p className="secondary__empty">没有可选项</p>
          ) : (
            <ul className="secondary__list">
              {group.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`secondary__item${item.tone === 'active' ? ' is-active' : ''}${
                      item.tone === 'muted' ? ' is-muted' : ''
                    }`}
                    onClick={item.onSelect}
                  >
                    <span className="secondary__label">{item.label}</span>
                    {item.badge ? <span className="secondary__badge">{item.badge}</span> : null}
                    {item.hint ? <span className="secondary__hint">{item.hint}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      {isEmpty && emptyHint ? <p className="secondary__empty">{emptyHint}</p> : null}
    </nav>
  );
}

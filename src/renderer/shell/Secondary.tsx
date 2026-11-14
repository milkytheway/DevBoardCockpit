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
export function Secondary({ groups }: { groups: SecondaryGroup[] }): JSX.Element {
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
                    // **稳定的 e2e 钩子**（不认 class 名 —— 外壳的 DOM 可以整个换掉）
                    data-cockpit-card-id={item.cardId}
                    data-cockpit-session-id={item.sessionId}
                    onClick={item.onSelect}
                  >
                    <span className="secondary__label">{item.label}</span>
                    {item.badge ? <span className="secondary__badge">{item.badge}</span> : null}
                    {item.hint ? <span className="secondary__hint">{item.hint}</span> : null}
                  </button>
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
              ))}
            </ul>
          )}
        </section>
      ))}
    </nav>
  );
}

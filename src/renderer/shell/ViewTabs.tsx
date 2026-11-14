import { PlusIcon } from './Icons';
import { VIEWS, type ViewId } from './types';

export function ViewTabs({
  view,
  onView,
  onAddView,
}: {
  view: ViewId;
  onView: (view: ViewId) => void;
  onAddView: () => void;
}): JSX.Element {
  return (
    <nav className="viewtabs" aria-label="工作区视图">
      {VIEWS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`viewtabs__tab ${view === item.id ? 'is-active' : ''}`}
          onClick={() => onView(item.id)}
          aria-current={view === item.id ? 'page' : undefined}
          title={item.hint}
        >
          {item.name}
        </button>
      ))}
      <button
        type="button"
        className="viewtabs__add"
        onClick={onAddView}
        title="另存视图（M6 起可编辑）"
        aria-label="新建视图"
      >
        <PlusIcon size={14} />
      </button>
      <span className="spacer" />
      <span className="viewtabs__hint">
        {VIEWS.find((item) => item.id === view)?.hint ?? ''}
      </span>
    </nav>
  );
}

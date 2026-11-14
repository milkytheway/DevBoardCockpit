import { PlusIcon, RefreshIcon } from './Icons';
import { VIEWS, type ViewId } from './types';

export function Toolbar({
  view,
  cardsCount,
  tagCount,
  onRefresh,
  onOpenLibrary,
  onOpenDock,
}: {
  view: ViewId;
  cardsCount: number;
  tagCount: number;
  onRefresh: () => void;
  onOpenLibrary: () => void;
  onOpenDock: () => void;
}): JSX.Element {
  return (
    <div className="toolbar">
      <div className="toolbar__title">
        <h1>{VIEWS.find((item) => item.id === view)?.name ?? '工作台'}</h1>
        <span className="toolbar__counts">
          <span className="mono">{cardsCount}</span> 张卡 · <span className="mono">{tagCount}</span> 个 tag
        </span>
      </div>
      <span className="spacer" />
      <button type="button" className="btn btn--ghost btn--sm" onClick={onRefresh} title="重新扫描卡片目录">
        <RefreshIcon size={14} />
        刷新卡片
      </button>
      <button type="button" className="btn btn--ghost btn--sm" onClick={onOpenDock}>
        终端
      </button>
      <button type="button" className="btn btn--ghost btn--sm" onClick={onOpenLibrary}>
        卡片库
      </button>
      <button type="button" className="btn btn--primary btn--sm" onClick={onOpenLibrary}>
        <PlusIcon size={14} />
        添加卡片
      </button>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import type { ViewDensity } from '../../shared/layout';
import { GearIcon, PlusIcon, RefreshIcon } from './Icons';
import { VIEWS, type ViewId } from './types';

/**
 * View toolbar: counts, view-level display settings (density / tag filter /
 * hidden cards) and the shortcuts into the library and the dock.
 */
export function Toolbar({
  view,
  cardsCount,
  tagCount,
  density,
  tagFilter,
  hiddenCount,
  onRefresh,
  onOpenLibrary,
  onOpenDock,
  onDensity,
  onTagFilter,
  onUnhideAll,
}: {
  view: ViewId;
  cardsCount: number;
  tagCount: number;
  density: ViewDensity;
  tagFilter: readonly string[];
  hiddenCount: number;
  onRefresh: () => void;
  onOpenLibrary: () => void;
  onOpenDock: () => void;
  onDensity: (density: ViewDensity) => void;
  onTagFilter: (patterns: string[]) => void;
  onUnhideAll: () => void;
}): JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filterText, setFilterText] = useState(tagFilter.join(', '));
  const settingsRef = useRef<HTMLDivElement | null>(null);

  // Re-sync when the active view changes (each view has its own filter).
  useEffect(() => {
    setFilterText(tagFilter.join(', '));
  }, [tagFilter]);

  // Popover behaves like a menu: Escape or a click outside closes it.
  useEffect(() => {
    if (!settingsOpen) return undefined;
    const onPointerDown = (event: MouseEvent): void => {
      const root = settingsRef.current;
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        setSettingsOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSettingsOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [settingsOpen]);

  const commitFilter = (): void => {
    const patterns = filterText
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    onTagFilter(patterns);
  };

  return (
    <div className="toolbar">
      <div className="toolbar__title">
        <h1>{VIEWS.find((item) => item.id === view)?.name ?? '工作台'}</h1>
        <span className="toolbar__counts">
          <span className="mono">{cardsCount}</span> 张卡 · <span className="mono">{tagCount}</span> 个 tag
        </span>
      </div>
      <span className="spacer" />
      <div className="view-settings" ref={settingsRef}>
        <button
          type="button"
          className={`btn btn--ghost btn--sm ${settingsOpen ? 'is-active' : ''}`}
          onClick={() => setSettingsOpen((open) => !open)}
          aria-expanded={settingsOpen}
          title="视图设置（密度 / 读数过滤 / 隐藏的卡片）"
        >
          <GearIcon size={14} />
          视图
        </button>
        {settingsOpen ? (
          <div className="view-settings__pop" role="dialog" aria-label="视图设置">
            <section>
              <span className="eyebrow">密度</span>
              <div className="segmented">
                <button
                  type="button"
                  className={density === 'comfortable' ? 'is-active' : ''}
                  onClick={() => onDensity('comfortable')}
                >
                  舒适
                </button>
                <button
                  type="button"
                  className={density === 'compact' ? 'is-active' : ''}
                  onClick={() => onDensity('compact')}
                >
                  紧凑
                </button>
              </div>
            </section>
            <section>
              <span className="eyebrow">读数过滤</span>
              <input
                className="view-settings__input mono"
                value={filterText}
                placeholder="cpu.*, gpu.*（* 通配；空=全部）"
                onChange={(event) => setFilterText(event.target.value)}
                onBlur={commitFilter}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitFilter();
                }}
              />
              <span className="dim">只影响本视图的读数列表与监控指标。</span>
            </section>
            <section>
              <span className="eyebrow">本视图隐藏</span>
              <span className="dim">
                {hiddenCount > 0 ? `${hiddenCount} 张卡被收起（其它视图不受影响）` : '没有隐藏的卡片'}
              </span>
              {hiddenCount > 0 ? (
                <button type="button" className="btn btn--ghost btn--sm" onClick={onUnhideAll}>
                  全部恢复
                </button>
              ) : null}
            </section>
          </div>
        ) : null}
      </div>
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

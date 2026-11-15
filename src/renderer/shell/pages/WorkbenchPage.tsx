import type { CardInstanceInfo } from '../../../shared/ipc-contract';
import type { LayoutUnit, ViewDensity } from '../../../shared/layout';
import type { ThemeName } from '../../../shared/theme/seed';
import type { CardBroker } from '../../cards/broker';
import { CardGrid } from '../cards/CardGrid';
import { ActivityIcon, GridIcon, LayersIcon, RefreshIcon } from '../Icons';

/**
 * The workbench: **the main area is the cards, and nothing else**.
 *
 * The page header carries the only page-level controls (density, refresh,
 * the way to the card library); everything else belongs to the cards.
 */
export function WorkbenchPage({
  cards,
  units,
  broker,
  theme,
  density,
  selectedInstanceId,
  onSelect,
  onOpenDetail,
  onRemove,
  onLayoutChange,
  onOpenLibrary,
  onDensity,
  onRefreshCards,
}: {
  /** The cards placed in the main area. */
  cards: CardInstanceInfo[];
  units: LayoutUnit[];
  /** Null while the host API is still loading. */
  broker: CardBroker | null;
  theme: ThemeName;
  density: ViewDensity;
  selectedInstanceId: string | null;
  onSelect: (info: CardInstanceInfo) => void;
  onOpenDetail: (info: CardInstanceInfo) => void;
  onRemove: (info: CardInstanceInfo) => void;
  onLayoutChange: (units: LayoutUnit[]) => void;
  onOpenLibrary: () => void;
  onDensity: (density: ViewDensity) => void;
  onRefreshCards: () => void;
}): JSX.Element {
  return (
    <div className="page page--workbench">
      <header className="page-head page-head--compact">
        <div className="page-head__text">
          <h1 className="page-head__title">总览</h1>
        </div>
        <div className="page-head__actions">
          <div className="segmented segmented--density" role="group" aria-label="卡片密度">
            <button
              type="button"
              className={density === 'comfortable' ? 'is-active' : ''}
              onClick={() => onDensity('comfortable')}
              title="舒适：更大的卡片行高"
            >
              舒适
            </button>
            <button
              type="button"
              className={density === 'compact' ? 'is-active' : ''}
              onClick={() => onDensity('compact')}
              title="紧凑：一屏放更多卡片"
            >
              紧凑
            </button>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={onRefreshCards}
            title="重新扫描卡片目录"
          >
            <RefreshIcon size={14} />
            刷新
          </button>
          <button type="button" className="btn btn--primary btn--sm" onClick={onOpenLibrary}>
            <LayersIcon size={14} />
            卡片库
          </button>
        </div>
      </header>

      {cards.length === 0 && broker !== null ? (
        <div className="workbench-empty" data-testid="user-grid">
          <div className="workbench-empty__art" aria-hidden>
            <span className="workbench-empty__tile workbench-empty__tile--one" />
            <span className="workbench-empty__tile workbench-empty__tile--two" />
            <span className="workbench-empty__tile workbench-empty__tile--three" />
            <GridIcon size={26} />
          </div>
          <h2>把仪表台拼出来</h2>
          <p>
            卡片是文件，不是插件。去卡片库挑一张——CPU、内存、温度、板卡身份，
            或者让 AI 写一张新的。
          </p>
          <div className="workbench-empty__actions">
            <button type="button" className="btn btn--primary" onClick={onOpenLibrary}>
              <LayersIcon size={15} />
              打开卡片库
            </button>
            <span className="workbench-empty__hint">
              <ActivityIcon size={14} /> 布局自动保存
            </span>
          </div>
        </div>
      ) : (
        <CardGrid
          cards={cards}
          units={units}
          broker={broker}
          theme={theme}
          density={density}
          selectedInstanceId={selectedInstanceId}
          onSelect={onSelect}
          onOpenDetail={onOpenDetail}
          onRemove={onRemove}
          onLayoutChange={onLayoutChange}
        />
      )}
    </div>
  );
}

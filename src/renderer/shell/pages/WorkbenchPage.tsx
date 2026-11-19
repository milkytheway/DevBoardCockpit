import type { CardInstanceInfo } from '../../../shared/ipc-contract';
import type { LayoutUnit, ViewDensity } from '../../../shared/layout';
import type { ThemeName } from '../../../shared/theme/seed';
import type { CardBroker } from '../../cards/broker';
import { CardGrid } from '../cards/CardGrid';
import { useT, type Localised } from '../i18n';
import { ActivityIcon, GridIcon, LayersIcon, RefreshIcon } from '../Icons';

/**
 * **界面文案** —— 用户读得到的字都在这一张表里 ✓。
 *
 * 词条挨着用到它的代码，`t()` 按当前语言挑一条 ✓。
 */
const strings = {
  title: { 'zh-Hans': '总览', en: 'Overview' },
  densityGroup: { 'zh-Hans': '卡片密度', en: 'Card density' },
  comfortable: { 'zh-Hans': '舒适', en: 'Comfortable' },
  comfortableHint: { 'zh-Hans': '舒适：更大的卡片行高', en: 'Comfortable: taller card rows' },
  compact: { 'zh-Hans': '紧凑', en: 'Compact' },
  compactHint: { 'zh-Hans': '紧凑：一屏放更多卡片', en: 'Compact: more cards on one screen' },
  rescanHint: { 'zh-Hans': '重新扫描卡片目录', en: 'Rescan the card directories' },
  refresh: { 'zh-Hans': '刷新', en: 'Refresh' },
  cardLibrary: { 'zh-Hans': '卡片库', en: 'Card library' },
  emptyTitle: { 'zh-Hans': '把仪表台拼出来', en: 'Assemble the dashboard' },
  emptyBody: {
    'zh-Hans': '卡片是文件，不是插件。去卡片库挑一张——CPU、内存、温度、板卡身份，或者让 AI 写一张新的。',
    en: 'Cards are files, not plugins. Pick one in the card library — CPU, memory, temperature, board identity — or let the AI write a new one.',
  },
  openLibrary: { 'zh-Hans': '打开卡片库', en: 'Open the card library' },
  layoutAutosaves: { 'zh-Hans': '布局自动保存', en: 'The layout saves itself' },
} satisfies Record<string, Localised>;

/**
 * The workbench: **the main area is the cards, and nothing else**.
 *
 * The page header carries the only page-level controls (density, refresh,
 * the way to the card library); everything else belongs to the cards.
 *
 * ── 「选板子」不在这里 ──
 *
 * → 它在**界面最顶端** ✓（标题条 ✓ —— 用户 2026-11-16 明确 ✓）
 * → **页面头会跟着页面换位置** ✗ → 「我在这块板上」**得一直在** ✓。
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
  const t = useT();
  return (
    <div className="page page--workbench">
      <header className="page-head page-head--compact">
        <div className="page-head__text">
          <h1 className="page-head__title">{t(strings.title)}</h1>
        </div>
        <div className="page-head__actions">
          <div className="segmented segmented--density" role="group" aria-label={t(strings.densityGroup)}>
            <button
              type="button"
              className={density === 'comfortable' ? 'is-active' : ''}
              onClick={() => onDensity('comfortable')}
              title={t(strings.comfortableHint)}
            >
              {t(strings.comfortable)}
            </button>
            <button
              type="button"
              className={density === 'compact' ? 'is-active' : ''}
              onClick={() => onDensity('compact')}
              title={t(strings.compactHint)}
            >
              {t(strings.compact)}
            </button>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={onRefreshCards}
            title={t(strings.rescanHint)}
          >
            <RefreshIcon size={14} />
            {t(strings.refresh)}
          </button>
          <button type="button" className="btn btn--primary btn--sm" onClick={onOpenLibrary}>
            <LayersIcon size={14} />
            {t(strings.cardLibrary)}
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
          <h2>{t(strings.emptyTitle)}</h2>
          <p>{t(strings.emptyBody)}</p>
          <div className="workbench-empty__actions">
            <button type="button" className="btn btn--primary" onClick={onOpenLibrary}>
              <LayersIcon size={15} />
              {t(strings.openLibrary)}
            </button>
            <span className="workbench-empty__hint">
              <ActivityIcon size={14} /> {t(strings.layoutAutosaves)}
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
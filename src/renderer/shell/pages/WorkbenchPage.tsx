import type { CardInstanceInfo } from '../../../shared/ipc-contract';
import type { LayoutUnit, ViewDensity } from '../../../shared/layout';
import type { CardBroker } from '../../cards/broker';
import { CardGrid } from '../cards/CardGrid';

/**
 * The workbench: **the main area is the cards, and nothing else**.
 *
 * ── what is not here ──
 *
 * There used to be a strip above the grid ("overview"): a card with the
 * target and the link on the left, a live reading table on the right.
 * It said a lot and meant little — and it pushed the cards (the thing
 * people actually came for) into the bottom half of the screen.
 *
 * Now:
 *
 * - the **cards** are the main area,
 * - the **link state** lives in the secondary sidebar's status block,
 * - the **readings** belong to the cards (each card subscribes to the tags
 *   it cares about and renders them itself).
 */
export function WorkbenchPage({
  cards,
  units,
  broker,
  density,
  selectedInstanceId,
  onSelect,
  onOpenDetail,
  onRemove,
  onLayoutChange,
}: {
  /** The cards placed in the main area. */
  cards: CardInstanceInfo[];
  units: LayoutUnit[];
  /** Null while the host API is still loading. */
  broker: CardBroker | null;
  density: ViewDensity;
  selectedInstanceId: string | null;
  onSelect: (info: CardInstanceInfo) => void;
  onOpenDetail: (info: CardInstanceInfo) => void;
  onRemove: (info: CardInstanceInfo) => void;
  onLayoutChange: (units: LayoutUnit[]) => void;
}): JSX.Element {
  return (
    <div className="page page--workbench">
      <CardGrid
        cards={cards}
        units={units}
        broker={broker}
        density={density}
        selectedInstanceId={selectedInstanceId}
        onSelect={onSelect}
        onOpenDetail={onOpenDetail}
        onRemove={onRemove}
        onLayoutChange={onLayoutChange}
      />
    </div>
  );
}

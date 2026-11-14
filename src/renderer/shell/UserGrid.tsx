import { useCallback, useMemo } from 'react';
import GridLayout, { WidthProvider, type Layout } from 'react-grid-layout';
import type { CardInstanceInfo } from '../../shared/ipc-contract';
import type { LayoutUnit } from '../../shared/layout';
import type { CardBroker } from '../cards/broker';
import { CardShell } from './CardShell';
import { resolveLayout, slotKey, splitKey } from './layout-utils';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

const COLUMNS = 12;
const ROW_HEIGHT = 60;
const MIN_W = 2;
const MIN_H = 2;

const Grid = WidthProvider(GridLayout);

export function UserGrid({
  cards,
  units,
  broker,
  selectedCardId,
  onSelect,
  onOpenInspector,
  onLayoutChange,
}: {
  cards: CardInstanceInfo[];
  units: LayoutUnit[];
  broker: CardBroker;
  selectedCardId: string | null;
  onSelect: (info: CardInstanceInfo) => void;
  onOpenInspector: (info: CardInstanceInfo) => void;
  onLayoutChange: (units: LayoutUnit[]) => void;
}): JSX.Element {
  const resolved = useMemo(() => resolveLayout(cards, units), [cards, units]);

  const layout = useMemo<Layout[]>(
    () =>
      resolved.map((unit) => ({
        i: slotKey(unit.cardId, unit.connectionId),
        x: unit.x,
        y: unit.y,
        w: unit.w,
        h: unit.h,
        minW: MIN_W,
        minH: MIN_H,
      })),
    [resolved],
  );

  const handleChange = useCallback(
    (next: Layout[]) => {
      onLayoutChange(
        next.map((item) => {
          const { cardId, connectionId } = splitKey(item.i);
          return { cardId, connectionId, x: item.x, y: item.y, w: item.w, h: item.h };
        }),
      );
    },
    [onLayoutChange],
  );

  const byCard = useMemo(() => new Map(cards.map((c) => [c.cardId, c])), [cards]);

  return (
    <div className="cockpit-user-grid" data-testid="user-grid">
      <Grid
        className="cockpit-grid"
        layout={layout}
        cols={COLUMNS}
        rowHeight={ROW_HEIGHT}
        margin={[12, 12]}
        containerPadding={[0, 0]}
        draggableHandle=".cockpit-card__handle"
        useCSSTransforms
        onLayoutChange={handleChange}
      >
        {cards.map((card) => {
          const key = slotKey(card.cardId, card.connectionId);
          const info = byCard.get(card.cardId) ?? card;
          return (
            <div key={key} className="cockpit-grid__item">
              <CardShell
                info={info}
                broker={broker}
                selected={selectedCardId === info.instanceId}
                onSelect={onSelect}
                onOpenInspector={onOpenInspector}
              />
            </div>
          );
        })}
      </Grid>
    </div>
  );
}

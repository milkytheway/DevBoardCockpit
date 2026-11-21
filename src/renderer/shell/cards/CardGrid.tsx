import { useCallback, useEffect, useMemo, useRef } from 'react';
import GridLayout, { WidthProvider, type Layout } from 'react-grid-layout';
import type { CardInstanceInfo } from '../../../shared/ipc-contract';
import type { LayoutUnit, ViewDensity } from '../../../shared/layout';
import type { ThemeName } from '../../../shared/theme/seed';
import type { CardBroker } from '../../cards/broker';
import { CardShell } from './CardShell';
import { useT, type Localised } from '../i18n';
import { resolveLayout, slotKey, splitKey } from '../layout-utils';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

/**
 * The card grid: the **only** thing the workbench's main area shows.
 *
 * ── a card lives in a cell; the host owns the chrome ──
 *
 * Each cell is one card instance. The host draws the title bar, the drag
 * handle, the state chip and the menu; the card itself only ever draws
 * inside its iframe (an opaque origin — it cannot reach the host's DOM).
 *
 * ── writes are debounced ──
 *
 * `onLayoutChange` fires on every frame of a drag. Persisting each frame
 * would hammer the disk and the IPC; the position only matters when the
 * user lets go. → 300 ms after the last change.
 */
const COLUMNS = 12;
const MIN_W = 2;
const MIN_H = 2;
/** Row height per density. */
const ROW_HEIGHT: Record<ViewDensity, number> = { comfortable: 64, compact: 44 };
/** How long the grid waits before it persists a drag. */
const SAVE_DEBOUNCE_MS = 300;

/** The wording of the grid, in both languages. */
const strings = {
  empty: { 'zh-Hans': '主区还没有卡片', en: 'No cards in the work area' },
} satisfies Record<string, Localised>;

const Grid = WidthProvider(GridLayout);

export function CardGrid({
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
}: {
  /** The cards that are **placed** in the main area right now. */
  cards: CardInstanceInfo[];
  units: LayoutUnit[];
  /** Null while the host API is still loading (then there is nothing to show). */
  broker: CardBroker | null;
  theme: ThemeName;
  density: ViewDensity;
  selectedInstanceId: string | null;
  onSelect: (info: CardInstanceInfo) => void;
  onOpenDetail: (info: CardInstanceInfo) => void;
  onRemove: (info: CardInstanceInfo) => void;
  onLayoutChange: (units: LayoutUnit[]) => void;
}): JSX.Element {
  const t = useT();
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

  // Debounce the write: a drag fires a change per frame.
  const timerRef = useRef<number | null>(null);
  const pendingRef = useRef<LayoutUnit[] | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const handleChange = useCallback(
    (next: Layout[]) => {
      const units = next.map((item) => {
        const { cardId, connectionId } = splitKey(item.i);
        return { cardId, connectionId, x: item.x, y: item.y, w: item.w, h: item.h };
      });
      pendingRef.current = units;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const pending = pendingRef.current;
        pendingRef.current = null;
        if (pending !== null) onLayoutChange(pending);
      }, SAVE_DEBOUNCE_MS);
    },
    [onLayoutChange],
  );

  // **Index by slot key, not by card id** — one card can have several
  // instances (one per connection), and they are different cards on screen.
  const bySlot = useMemo(
    () => new Map(cards.map((c) => [slotKey(c.cardId, c.connectionId), c])),
    [cards],
  );

  if (cards.length === 0 || broker === null) {
    return (
      <div className="card-grid is-empty" data-testid="user-grid">
        <p className="card-grid__empty">{t(strings.empty)}</p>
      </div>
    );
  }

  return (
    <div className={`card-grid${density === 'compact' ? ' card-grid--compact' : ''}`} data-testid="user-grid">
      <Grid
        className="card-grid__grid"
        layout={layout}
        cols={COLUMNS}
        rowHeight={ROW_HEIGHT[density]}
        margin={[14, 14]}
        containerPadding={[0, 0]}
        // **A data attribute, not a class name** —
        // e2e looks for exactly that (`data-cockpit-drag-handle`);
        // if the two places each carry a name of their own, changing one of
        // them leaves the other quietly mismatched.
        draggableHandle="[data-cockpit-drag-handle='true']"
        resizeHandles={['se']}
        useCSSTransforms
        onLayoutChange={handleChange}
      >
        {cards.map((card) => {
          const key = slotKey(card.cardId, card.connectionId);
          const info = bySlot.get(key) ?? card;
          return (
            <div key={key} className="card-grid__item">
              <CardShell
                info={info}
                broker={broker}
                theme={theme}
                selected={selectedInstanceId === info.instanceId}
                onSelect={onSelect}
                onOpenDetail={onOpenDetail}
                onRemove={onRemove}
              />
            </div>
          );
        })}
      </Grid>
    </div>
  );
}

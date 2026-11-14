import { useCallback, useMemo } from 'react';
import GridLayout, { WidthProvider, type Layout } from 'react-grid-layout';
import type { LayoutUnit } from '../../shared/layout';
import type { CardInstanceInfo } from '../../shared/ipc-contract';
import { UserCard } from './user-card';
import type { CardBroker } from './broker';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

/**
 * 卡片区的那张**网格**。
 *
 * ── 它只认「格子」，不认实现 ──
 *
 * 网格里装的是 **Slot**（`kind: 'builtin' | 'user'`）——
 * 内置卡（宿主的 React 组件）与用户卡（沙箱 iframe）**同一套布局**。
 * 布局引擎只管「Slot 在哪、多大」，**不关心里面是什么**——
 * 这样将来 M8 的 promote / 全屏 / 布局分享不必再动布局系统。
 *
 * **v1 只实现 `kind: 'user'`**（用户卡）；内置卡留给 M5b 的容器卡。
 *
 * ── 拖拽手柄是**宿主画的** ──
 *
 * 卡片自己碰不到宿主的 chrome（契约 §六）→ 手柄是宿主加的一小条 ✓
 * 而且不设手柄的话，拖拽会和 iframe 内部的内容抢鼠标。
 */

/** 12 列网格（契约 §2.4 的默认格） */
const COLUMNS = 12;
/** 一行多高（px） */
const ROW_HEIGHT = 72;
/** 最小格子 */
const MIN_W = 1;
const MIN_H = 1;

/** 格子的键：`(cardId, connectionId)` */
function slotKey(cardId: string, connectionId: string | null): string {
  return `${cardId}::${connectionId ?? ''}`;
}

/** 从键里拆回 `(cardId, connectionId)` */
function splitKey(key: string): { cardId: string; connectionId: string | null } {
  const at = key.indexOf('::');
  if (at < 0) return { cardId: key, connectionId: null };
  const connectionId = key.slice(at + 2);
  return { cardId: key.slice(0, at), connectionId: connectionId === '' ? null : connectionId };
}

const Grid = WidthProvider(GridLayout);

export function Board({
  units,
  cards,
  broker,
  onLayoutChange,
}: {
  /** 有效布局（宿主算好的：没挪过的卡用 manifest 的默认尺寸） */
  units: LayoutUnit[];
  /** 装着的卡片 */
  cards: CardInstanceInfo[];
  broker: CardBroker;
  /** 拖完了（宿主存起来） */
  onLayoutChange: (units: LayoutUnit[]) => void;
}): JSX.Element {
  const layout = useMemo<Layout[]>(
    () =>
      units.map((unit) => ({
        i: slotKey(unit.cardId, unit.connectionId),
        x: unit.x,
        y: unit.y,
        w: unit.w,
        h: unit.h,
        minW: MIN_W,
        minH: MIN_H,
      })),
    [units],
  );

  const handleChange = useCallback(
    (next: Layout[]) => {
      onLayoutChange(
        next.map((item) => {
          const { cardId, connectionId } = splitKey(item.i);
          return {
            cardId,
            connectionId,
            x: item.x,
            y: item.y,
            w: item.w,
            h: item.h,
          };
        }),
      );
    },
    [onLayoutChange],
  );

  return (
    <Grid
      className="card-board"
      layout={layout}
      cols={COLUMNS}
      rowHeight={ROW_HEIGHT}
      margin={[12, 12]}
      containerPadding={[0, 0]}
      onLayoutChange={handleChange}
      draggableHandle=".card-board__handle"
      useCSSTransforms
    >
      {cards.map((card) => {
        const key = slotKey(card.cardId, card.connectionId);
        return (
          <div key={key} className="card-board__cell">
            {/* 拖拽手柄（宿主画的，卡片碰不到） */}
            <div
              className="card-board__handle"
              data-card-id={card.cardId}
              title="拖动可以摆位置"
            >
              <span className="card-board__handle-title">{card.cardId}</span>
            </div>
            <UserCard info={card} broker={broker} />
          </div>
        );
      })}
    </Grid>
  );
}

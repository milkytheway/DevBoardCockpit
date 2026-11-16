import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CardInstanceInfo,
  ConnectionInfo,
  PermissionActor,
  PermissionRow,
} from '../../shared/ipc-contract';
import type { LayoutState, LayoutUnit, ViewDensity } from '../../shared/layout';
import { defaultUnit, withDensity, withUnits } from '../../shared/layout';
import type { RuntimeStatus } from '../../shared/runtime-status';
import type { TagReading } from '../../shared/tag-reading';
import { CardBroker } from '../cards/broker';
import type { ActivityEntry, ActivityLevel } from './types';

/**
 * The shell's data layer.
 *
 * ── one hook per thing, each owning its own subscription ──
 *
 * The shell used to hold 22 `useState`s and one big wiring effect. Splitting
 * the data out means each piece of live data has exactly one owner and one
 * place where it is refreshed.
 *
 * ── the rule that matters: **the layout is never re-read after boot** ──
 *
 * Reading the layout back from disk overwrites whatever the user just
 * dragged. The card list and the layout are separate files with separate
 * lifetimes: the card list changes when the card directory changes, the
 * layout changes when the user drags. Merging them is how "I moved a card
 * and it jumped back" happens.
 */

/** Reports a failure to the shell's error bar. Stable across renders. */
export type ReportError = (message: string) => void;

/** Keep the latest callback without making effects depend on it. */
function useLatest<T>(value: T): { current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/**
 * Connection profiles.
 *
 * → **开机读一次** ✓（profile 只在重启时变 ✓），
 *   **但「哪条是当前」会变** ✓（用户换了设备 ✓）→ **所以要能刷新** ✓。
 */
export function useConnections(reportError: ReportError): {
  connections: ConnectionInfo[];
  refresh: () => void;
} {
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const report = useLatest(reportError);

  const refresh = useCallback(() => {
    const api = window.cockpit;
    if (!api) return;
    void api
      .connectionsList()
      .then((list) => setConnections(list))
      .catch((cause: unknown) =>
        report.current(cause instanceof Error ? cause.message : String(cause)),
      );
  }, [report]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { connections, refresh };
}

/** Runtime status: once at boot, then polled (the host has no push for it). */
/**
 * **统一权限区**（设置页那张表 ✓ · ADR-D47 ✓）。
 *
 * → **一次读** ✓（**设置页打开时读** ✓ —— **不是轮询** ✓ —— **它很少变** ✓）
 * → **改一条就重读** ✓（**改完立刻看到** ✓）。
 */
export function usePermissions(reportError: ReportError): {
  rows: PermissionRow[];
  set: (actor: PermissionActor, op: string, allowed: boolean) => void;
} {
  const [rows, setRows] = useState<PermissionRow[]>([]);
  const report = useLatest(reportError);

  const refresh = useCallback(() => {
    const api = window.cockpit;
    if (!api) return;
    void api
      .permissionsList()
      .then((list) => setRows(list))
      .catch((cause: unknown) =>
        report.current(cause instanceof Error ? cause.message : String(cause)),
      );
  }, [report]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const set = useCallback(
    (actor: PermissionActor, op: string, allowed: boolean) => {
      const api = window.cockpit;
      if (!api) return;
      void api
        .permissionsSet(actor, op, allowed)
        .then(refresh)
        .catch((cause: unknown) =>
          report.current(cause instanceof Error ? cause.message : String(cause)),
        );
    },
    [refresh, report],
  );

  return { rows, set };
}

export function useRuntime(pollMs = 3000): RuntimeStatus {
  const [runtime, setRuntime] = useState<RuntimeStatus>({ state: 'idle' });
  useEffect(() => {
    const api = window.cockpit;
    if (!api) return undefined;
    let disposed = false;
    void api
      .tagsStatus()
      .then((status) => {
        if (!disposed) setRuntime(status);
      })
      .catch(() => undefined);
    const timer = window.setInterval(() => {
      void api
        .tagsStatus()
        .then((status) => {
          if (!disposed) setRuntime(status);
        })
        .catch(() => undefined);
    }, pollMs);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [pollMs]);
  return runtime;
}

/**
 * The installed cards.
 *
 * Refreshed when the card directory changes — and **only** the card list:
 * the layout is not touched here (see `useLayout`).
 */
export function useCards(reportError: ReportError): {
  cards: CardInstanceInfo[];
  refresh: () => void;
} {
  const [cards, setCards] = useState<CardInstanceInfo[]>([]);
  const report = useLatest(reportError);

  const refresh = useCallback(() => {
    const api = window.cockpit;
    if (!api) return;
    void api
      .cardsList()
      .then((list) => setCards(list))
      .catch((cause: unknown) =>
        report.current(cause instanceof Error ? cause.message : String(cause)),
      );
  }, [report]);

  useEffect(() => {
    const api = window.cockpit;
    if (!api) return undefined;
    refresh();
    const off = api.onCardsChanged(() => refresh());
    return off;
  }, [refresh]);

  return { cards, refresh };
}

/** The grid the main area uses (mirrors `CardGrid`'s COLUMNS). */
const GRID_COLUMNS = 12;

/**
 * The first free spot for a card of `w×h`.
 *
 * Cards are placed one after another from left to right, top to bottom, so
 * clicking three cards in the library does not stack them all on (0, 0).
 */
function firstFreeSpot(
  units: readonly LayoutUnit[],
  w: number,
  h: number,
): { x: number; y: number } {
  const overlaps = (x: number, y: number): boolean =>
    units.some((u) => x < u.x + u.w && x + w > u.x && y < u.y + u.h && y + h > u.y);
  for (let y = 0; y < 200; y += 1) {
    for (let x = 0; x <= GRID_COLUMNS - w; x += 1) {
      if (!overlaps(x, y)) return { x, y };
    }
  }
  return { x: 0, y: 0 };
}

/**
 * The layout: what is placed in the main area.
 *
 * **Read once at boot, then patched.** A refresh of the card list must not
 * bring the layout back from disk — that is how a dragged card jumps back.
 */
export function useLayout(reportError: ReportError): {
  layout: LayoutState | null;
  units: LayoutUnit[];
  density: ViewDensity;
  placeCard: (card: CardInstanceInfo) => void;
  removeCard: (card: CardInstanceInfo) => void;
  setUnits: (units: LayoutUnit[]) => void;
  setDensity: (density: ViewDensity) => void;
} {
  const [layout, setLayout] = useState<LayoutState | null>(null);
  const layoutRef = useRef<LayoutState | null>(null);
  const report = useLatest(reportError);

  useEffect(() => {
    const api = window.cockpit;
    if (!api) return undefined;
    let disposed = false;
    void api
      .layoutGet()
      .then((loaded) => {
        if (disposed) return;
        layoutRef.current = loaded;
        setLayout(loaded);
      })
      .catch((cause: unknown) =>
        report.current(cause instanceof Error ? cause.message : String(cause)),
      );
    return () => {
      disposed = true;
    };
  }, [report]);

  const persist = useCallback(
    (next: LayoutState) => {
      layoutRef.current = next;
      setLayout(next);
      const api = window.cockpit;
      if (!api) return;
      void api.layoutSet(next).catch((cause: unknown) => {
        report.current(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [report],
  );

  const setUnits = useCallback(
    (units: LayoutUnit[]) => {
      const current = layoutRef.current;
      if (current === null) return;
      persist(withUnits(current, units));
    },
    [persist],
  );

  const setDensity = useCallback(
    (density: ViewDensity) => {
      const current = layoutRef.current;
      if (current === null) return;
      persist(withDensity(current, density));
    },
    [persist],
  );

  /** The key of a card in the layout: `(cardId, connectionId)`. */
  const keyOf = (card: CardInstanceInfo): string =>
    `${card.cardId}::${card.connectionId ?? ''}`;

  const placeCard = useCallback(
    (card: CardInstanceInfo) => {
      const current = layoutRef.current;
      if (current === null) return;
      const key = keyOf(card);
      if (current.units.some((u) => `${u.cardId}::${u.connectionId ?? ''}` === key)) return;
      // **默认格子只有一处**（shared/layout.ts 的 defaultUnit）：尺寸取卡片
      // 自报的 layout.w/h——作者的心愿；位置则找第一个空位，别让三张卡叠在
      // (0, 0)。
      const unit = defaultUnit(card.cardId, card.connectionId, card.layout);
      persist(withUnits(current, [...current.units, { ...unit, ...firstFreeSpot(current.units, unit.w, unit.h) }]));
    },
    [persist],
  );

  const removeCard = useCallback(
    (card: CardInstanceInfo) => {
      const current = layoutRef.current;
      if (current === null) return;
      const key = keyOf(card);
      persist(
        withUnits(
          current,
          current.units.filter((u) => `${u.cardId}::${u.connectionId ?? ''}` !== key),
        ),
      );
    },
    [persist],
  );

  return {
    layout,
    units: layout?.units ?? [],
    density: layout?.density ?? 'comfortable',
    placeCard,
    removeCard,
    setUnits,
    setDensity,
  };
}

/** The activity stream: what the host did, newest first. */
export function useActivity(limit = 200): {
  activity: ActivityEntry[];
  log: (level: ActivityLevel, message: string) => void;
} {  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const idRef = useRef(0);

  const log = useCallback(
    (level: ActivityLevel, message: string) => {
      idRef.current += 1;
      const entry: ActivityEntry = { id: idRef.current, at: Date.now(), level, message };
      setActivity((previous) => [entry, ...previous].slice(0, limit));
    },
    [limit],
  );

  return { activity, log };
}

/**
 * The tag stream: the latest reading for every tag plus a short history.
 *
 * The detail panel needs **raw host data**, not the pretty value the cards
 * draw: the same `TagReading` the main process puts into the store (status,
 * reason, at, seq). The history is renderer memory only — the host has no
 * "read history" IPC, and adding one is a main/contract change.
 */
export interface TagStream {
  /** Latest reading per tag, sorted by tag name. */
  readings: TagReading[];
  latestFor: (tag: string) => TagReading | undefined;
  historyFor: (tag: string) => readonly TagReading[];
  /** Total number of stored samples across every tag. */
  sampleCount: number;
}

export function useTagStream(limitPerTag = 120): TagStream {
  const latestRef = useRef(new Map<string, TagReading>());
  const historyRef = useRef(new Map<string, TagReading[]>());
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const api = window.cockpit;
    if (!api) return undefined;
    let disposed = false;
    const push = (reading: TagReading): void => {
      if (disposed) return;
      latestRef.current.set(reading.tag, reading);
      const history = historyRef.current.get(reading.tag) ?? [];
      history.push(reading);
      if (history.length > limitPerTag) history.splice(0, history.length - limitPerTag);
      historyRef.current.set(reading.tag, history);
      // One bump per batch is enough for React to re-render; a burst of
      // pushes in the same tick is rare (the sampler groups its reads).
      setVersion((value) => value + 1);
    };
    void api
      .tagsReadings()
      .then((list) => {
        for (const reading of list) push(reading);
      })
      .catch(() => undefined);
    const off = api.onTagChanged(push);
    return () => {
      disposed = true;
      off();
    };
  }, [limitPerTag]);

  const readings = useMemo(
    () => [...latestRef.current.values()].sort((a, b) => a.tag.localeCompare(b.tag)),
    // `version` is the render trigger: the maps are mutable refs.
    [version],
  );

  const latestFor = useCallback((tag: string) => latestRef.current.get(tag), []);
  const historyFor = useCallback(
    (tag: string): readonly TagReading[] => historyRef.current.get(tag) ?? [],
    [],
  );
  const sampleCount = useMemo(
    () => [...historyRef.current.values()].reduce((sum, list) => sum + list.length, 0),
    [version],
  );

  return { readings, latestFor, historyFor, sampleCount };
}

/**
 * The card broker: the only channel between a card and the host.
 *
 * Its behaviour is a security boundary (see `cards/broker.ts`) — this hook
 * only owns its lifetime.
 */
export function useBroker(): CardBroker | null {
  const [broker, setBroker] = useState<CardBroker | null>(null);
  useEffect(() => {
    const api = window.cockpit;
    if (!api) return undefined;
    const cardBroker = new CardBroker(api);
    setBroker(cardBroker);
    const onMessage = (event: MessageEvent): void => cardBroker.handleMessage(event);
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      cardBroker.dispose();
      setBroker(null);
    };
  }, []);
  return broker;
}

import { CORE_VOCABULARY } from '../../shared/generated/tag-vocabulary.generated';
import { matchTagPattern } from '../tags/vocabulary';
import type { TagReading } from '../../shared/tag-reading';
import type { PackView, ReaderView } from '../tags/pack-view';
import type { McpHostDeps, McpCardEntry, TagSampleLike } from './host';
import { deviceKeyOf } from '../profiles/schema';
import { withVersion, withVersionEach } from './convention';

export { withVersion, withVersionEach };

/**
 * The **projection of the read-side tools** (contract `spec/04` §2.1 / §2.2 /
 * §2.3 ✓ · ADR-D40 ✓).
 *
 * ── This layer only "translates" ──
 *
 * → **The words of the host side → the words of the contract** ✓:
 * | Host side | Contract |
 * |---|---|
 * | `TagReading.tag` | `name` ✓ |
 * | `LayoutUnit.cardId` | `card_id` ✓ |
 * | `LayoutUnit.units` | `cards` ✓ |
 * | `reader.id` | `id` ✓ |
 *
 * → **No decision is made here** ✓ — everything is computed on the host side ✓
 *   (`cards/state.ts` ✓ · `tags/pack-view.ts` ✓) ✓
 * → **Only the shape is done here** ✓ (contract §6 "the MCP server should be
 *   thin" ✓).
 */

/* ══════════════════════════════════════════════════════════════════
   Perceiving the current state (contract §2.1 ✓)
   ══════════════════════════════════════════════════════════════════ */

/** `list_connections` ✓ */
export function listConnections(deps: McpHostDeps): Record<string, unknown>[] {
  const current = deps.currentProfileId();
  return deps.profiles().map((profile) => ({
    id: profile.id,
    label: profile.label,
    transport: profile.transport,
    // **The id of the bound board pack** ✓ — **without a binding it is `null`** ✓ (**no version** ✓ — the version is a property of the pack itself ✓)
    board_pack: profile.board_pack ?? null,
    // **The identifier of this board** ✓ (contract `spec/02` §10.2 ✓) —
    // **Several connections of the same board give the same one** ✓ → so the agent knows which connections are the same board ✓
    device_key: deviceKeyOf(profile),
    // **Is it the connection of the current runtime** ✓ (**a different criterion from `connected`** ✓ — the two are not mixed ✓)
    current: current === profile.id,
    // **Does this profile have a live connection right now** ✓ (**looking only at "the runtime remembers it" is not enough** ✓ — that still has a value when it cannot connect ✓)
    connected: deps.connected(profile.id),
    // The **connection-level** capability bits ✓ (**not the board-level vocabulary** ✓)
    capabilities: deps.capabilities(profile),
  }));
}

/** `list_data_sources` ✓ */
export function listDataSources(deps: McpHostDeps): Record<string, unknown>[] {
  const pack = deps.pack();
  // **No pack → an empty array** ✓ (there is no data source ✓ — not "a pack with nothing in it" ✓)
  if (pack === null) return [];
  const readings = deps.readings();
  return pack.readers.map((reader) => ({
    // **The id of the reader** ✓ (a data source is at the granularity of a reader ✓ — the words of contract §2.1 ✓)
    id: reader.id,
    // **The id of the current board pack** ✓ (not the connection id ✓)
    board: pack.id,
    poll_group: reader.poll_group,
    kind: reader.kind,
    interval_ms: reader.interval_ms,
    // **Expanded into the concrete tag names** ✓ (the pack holds patterns ✓ — an agent that writes a card ✓ needs the concrete names ✓)
    provides: expandProvides(reader, readings),
    status: readerStatus(reader, readings),
  }));
}

/**
 * The **concrete tag names a reader provides** ✓.
 *
 * → **The patterns are expanded** ✓ (`cpu.core.*.usage` → the
 *   `cpu.core.0.usage` that really exists right now ✓ · …) ✓
 * → **The core that is not in the readings is not given** ✓ (**no guessing**
 *   ✓ — the sampler does not guess either ✓)
 * → **Not a single one → an empty array** ✓
 */
function expandProvides(reader: ReaderView, readings: TagReading[]): string[] {
  const out: string[] = [];
  for (const pattern of reader.provides) {
    for (const reading of readings) {
      if (matchTagPattern(pattern, reading.tag)) {
        if (!out.includes(reading.tag)) out.push(reading.tag);
      }
    }
  }
  return out.sort();
}

/**
 * **The state of the reader itself** ✓ (the mapping table of contract §2.1 ✓
 * — **not "the worst one"** ✓).
 *
 * | Case | State |
 * |---|---|
 * | none of its tags is in the readings | `pending` |
 * | there are tags, and all of them are `unavailable` | `unavailable` |
 * | there are tags, and one of them is `error` | `error` |
 * | there are tags, and one of them is `stale` (no error) | `stale` |
 * | all of them are `ok` | `ok` |
 */
function readerStatus(reader: ReaderView, readings: TagReading[]): TagReading['status'] {
  const mine = readings.filter((r) =>
    reader.provides.some((p) => matchTagPattern(p, r.tag)),
  );
  if (mine.length === 0) return 'pending';
  if (mine.some((r) => r.status === 'error')) return 'error';
  if (mine.every((r) => r.status === 'unavailable')) return 'unavailable';
  if (mine.some((r) => r.status === 'stale')) return 'stale';
  if (mine.some((r) => r.status === 'pending')) return 'pending';
  return 'ok';
}

/** `list_capabilities` ✓ */
export function listCapabilities(deps: McpHostDeps): Record<string, unknown> {
  const transports = new Set(deps.profiles().map((p) => p.transport));
  return {
    // The closed vocabulary of the **connection-level** capabilities ✓ (`exec` / `pty` / `files` / `exitCode` ✓ — **not the board-level one** ✓)
    transports: [...transports].sort(),
    // The capability bits of the **workbench itself** ✓ (closed ✓ — **adding a value means changing the contract** ✓)
    features: ['cards', 'mcp', 'layout_share', 'record'],
  };
}

/** `list_tags` ✓ */
export function listTags(deps: McpHostDeps): Record<string, unknown>[] {
  const pack = deps.pack();
  const readings = deps.readings();
  return readings.map((reading) => {
    const vocab = vocabularyEntry(reading.tag);
    return {
      // **The contract calls it `name`** ✓ (the host side calls it `tag` ✓ — **renamed** ✓)
      name: reading.tag,
      // **The type in the core vocabulary** ✓ — without an entry in the vocabulary it is `null` ✓
      type: vocab?.type ?? null,
      // **The unit** ✓ — without an entry in the vocabulary it is `'-'` (**not `null`** ✓ — dimensionless ✓)
      unit: vocab?.unit ?? '-',
      // **The range** ✓ — a two-element array or a string ✓ — without an entry in the vocabulary it is `null` ✓
      range: vocab?.range ?? null,
      status: reading.status,
      value: reading.value,
      // **The id of the current board pack** ✓ (**not the connection id** ✓)
      board: pack?.id ?? null,
      // **Which reader provides it** ✓ — `null` when it does not match ✓ (no guessing ✓)
      source_reader: sourceReaderOf(reading.tag, pack),
    };
  });
}

/** The entry of the core vocabulary that matches this tag ✓ (**the matching is by pattern** ✓) */
function vocabularyEntry(tag: string): (typeof CORE_VOCABULARY)[number] | undefined {
  return CORE_VOCABULARY.find((entry) => matchTagPattern(entry.pattern, tag));
}

/**
 * **Which reader provides this tag** ✓.
 *
 * → **Including the readers of `custom`** ✓ (otherwise every quantity of
 *   `custom.*` would be `null` ✓)
 * → **A tag matches at most one reader** ✓ (rule 2 of the board pack
 *   guarantees it ✓ — a pack that does not comply is not even loaded at
 *   runtime ✓)
 * → **`null` when it does not match** ✓ (no guessing ✓)
 */
function sourceReaderOf(tag: string, pack: PackView | null): string | null {
  if (pack === null) return null;
  for (const reader of pack.readers) {
    if (reader.provides.some((p) => matchTagPattern(p, tag))) return reader.id;
  }
  return null;
}

/** `describe_tag` ✓ */
export function describeTag(deps: McpHostDeps, name: string): Record<string, unknown> | null {
  const pack = deps.pack();
  const reading = deps.readings().find((r) => r.tag === name);
  const vocab = vocabularyEntry(name);
  const readerId = sourceReaderOf(name, pack);
  const reader = pack?.readers.find((r) => r.id === readerId) ?? null;
  return {
    name,
    type: vocab?.type ?? null,
    unit: vocab?.unit ?? '-',
    range: vocab?.range ?? null,
    // **The text of the vocabulary** ✓ (it contains the Markdown emphasis markers ✓ — the agent reads it as plain text ✓)
    // → **Without an entry in the vocabulary (the private quantities of `custom.*`) it is `null`** ✓
    semantics: vocab?.semantics ?? null,
    status: reading?.status ?? 'unavailable',
    value: reading?.value ?? null,
    board: pack?.id ?? null,
    source: {
      reader: reader?.id ?? null,
      kind: reader?.kind ?? null,
      // **The redacted arguments** ✓ — **the commands and the host paths are already blocked** ✓ (`tags/pack-view.ts` ✓)
      args_summary: reader?.args ?? {},
    },
    // **The most recent samples** ✓ — the same shape as `sample_tag` ✓
    history: deps.history(name, 64),
  };
}

/** `sample_tag` ✓ */
export function sampleTag(deps: McpHostDeps, name: string, n: number): TagSampleLike[] {
  return deps.history(name, n);
}

/* ══════════════════════════════════════════════════════════════════
   Looking up the existing cards (contract §2.2 ✓)
   ══════════════════════════════════════════════════════════════════ */

/** `list_cards` ✓ */
export function listCards(deps: McpHostDeps): Record<string, unknown>[] {
  return deps.cards().map((card: McpCardEntry) => ({
    // **card id = the name of the directory** ✓ (everything on the host side is indexed by it ✓)
    id: card.cardId,
    // **The id declared in the manifest** ✓ (**it may differ from the directory name** ✓ → so there are two fields ✓)
    manifest_id: card.manifest.id,
    name: card.manifest.name,
    version: card.manifest.version,
    // **The absolute path** ✓ (contract §4 ✓)
    path: card.dir,
    // **The last modification time of the directory** ✓ — **not "the moment the person clicked install"** ✓
    installed_at: card.state.installed_at,
    status: card.state.status,
    degraded: card.state.degraded,
    missing_tags: card.state.missing_tags,
    unreadable_tags: card.state.unreadable_tags,
  }));
}

/** `get_card_runtime_log` ✓ */
export function getCardRuntimeLog(
  deps: McpHostDeps,
  cardId: string,
  since: number | undefined,
): Record<string, unknown>[] {
  const entries = deps.cardLog(cardId);
  return entries
    // **The `since` filter is done on the host side** ✓ (contract §2.3 ✓)
    .filter((e) => since === undefined || e.at >= since)
    .map((e) => ({ level: e.level, at: e.at, message: e.message, source: e.source }));
}

/* ══════════════════════════════════════════════════════════════════
   The layout (contract §2.5 ✓)
   ══════════════════════════════════════════════════════════════════ */

/** `get_layout` ✓ */
export function getLayout(deps: McpHostDeps): Record<string, unknown> {
  const state = deps.layout();
  return {
    cards: state.units.map((u) => ({
      // **The contract calls it `card_id`** ✓ (the host side calls it `cardId` ✓ — **renamed** ✓)
      card_id: u.cardId,
      // **The connection id is added** ✓ — the key of the layout is `(card_id, connection_id)` ✓ — **without it the information is lost** ✗
      connection_id: u.connectionId,
      x: u.x,
      y: u.y,
      w: u.w,
      h: u.h,
    })),
  };
}

/**
 * **The normalisation of the layout** (contract §2.5 ✓) ✓ — **a cell that is
 * out of bounds is dropped as a whole** ✓.
 *
 * | Item | Rule |
 * |---|---|
 * | `x` / `y` | a non-negative integer ✓ |
 * | `w` | `1 ≤ w ≤ 12` ✓ |
 * | `h` | `h ≥ 1` ✓ |
 * | **Overlap** | **not judged** ✓ (left to the renderer ✓) |
 */
export function normalizeLayoutCards(
  cards: unknown,
): { cards: Array<{ card_id: string; connection_id: string | null; x: number; y: number; w: number; h: number }>; dropped: string[] } {
  const out: Array<{
    card_id: string;
    connection_id: string | null;
    x: number;
    y: number;
    w: number;
    h: number;
  }> = [];
  const dropped: string[] = [];
  if (!Array.isArray(cards)) return { cards: out, dropped };
  for (const raw of cards) {
    if (raw === null || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const cardId = typeof r['card_id'] === 'string' ? r['card_id'] : null;
    const conn = r['connection_id'];
    const x = r['x'];
    const y = r['y'];
    const w = r['w'];
    const h = r['h'];
    if (cardId === null) continue;
    const ok =
      typeof x === 'number' &&
      Number.isInteger(x) &&
      x >= 0 &&
      typeof y === 'number' &&
      Number.isInteger(y) &&
      y >= 0 &&
      typeof w === 'number' &&
      Number.isInteger(w) &&
      w >= 1 &&
      w <= 12 &&
      typeof h === 'number' &&
      Number.isInteger(h) &&
      h >= 1;
    if (!ok) {
      // **A cell that is out of bounds is dropped as a whole** ✓, **and its card_id is reported in `dropped[]`** ✓
      dropped.push(cardId);
      continue;
    }
    out.push({
      card_id: cardId,
      connection_id: typeof conn === 'string' ? conn : null,
      x,
      y,
      w,
      h,
    });
  }
  return { cards: out, dropped };
}

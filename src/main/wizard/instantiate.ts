import type { BoardPack, PollGroupDef, ReaderDef } from '../tags/schema';

/**
 * The instantiation — it turns the "generic pack" into "the pack of one
 * board" ✓.
 *
 * ── What it solves: the chicken-and-egg problem ✓ ──
 *
 * → The old way: a board pack is needed → then the board can be
 *   connected → then the probe → only then it is known what the board can
 *   do ✗
 * → The new way: connect the board with the generic pack ✓ → try
 *   the generic pack ✓ → what came out of it is the pack of this
 *   board ✓ ✓
 *
 * ── It is a pure function ✓ — it touches no file ✓ no connection ✓
 *   → easy to test ✓ (`tests/unit/wizard-instantiate.test.ts` ✓ ·
 *     9 criteria ✓)
 *   → Writing it to disk is another thing ✓ (`install.ts` ✓ — that is
 *     I/O ✓)
 *
 * ── ⚠️ It has to rewrite the `custom.` prefix (the step that is
 *    easiest to miss ✓) ──
 *
 * → Rule 1 ✓: the `tag` has to fall in the core vocabulary or under
 *   `custom.<this pack id>.` ✓
 *   (`isCustomTag(name, packId)` → `custom.${packId}.*` ✓).
 * → The id of the generic pack is `generic-linux` ✓ → its tags are
 *   necessarily `custom.generic-linux.*` ✓.
 * → The id of the instantiated pack is `atk-01` ✓ → those tags
 *   carried over as they are are stopped by rule 1 right away ⚠️
 *   → the pack that is written is illegal by nature ⚠️ → what the
 *   wizard produces is dead on arrival ⚠️.
 * → So: the prefix has to be rewritten ✓ — `custom.generic-linux.*` →
 *   `custom.atk-01.*` ✓.
 *
 * ── It has the same shape as the existing packs ──
 *
 * → The `custom.rk3588-atk.*` of the `rk3588-atk` pack ✓ → the same
 *   shape ✓
 * → So the product gets the validator for free ✓ → the criterion is
 *   "it has to pass the real validator" ✓.
 */

/** One result of the probe (whether one reader is green ✓) */
export interface ProbeOutcome {
  /** The id of the reader ✓ */
  readerId: string;
  /** Whether it is green ✓ */
  ok: boolean;
  /** Why it is red / what shape ✓ (for the reader ✓) */
  detail: string;
  /** The tags it produced (only a value when it is green ✓) */
  tags: { tag: string; value: unknown }[];
}

/** The connection is "how it was connected" ✓ (it goes into the provenance ✓ — "where this pack came from" ✓) */
export interface ProbeConnection {
  transport: string;
  port?: string;
  baudrate?: number;
}

/** One "this was guessed" ✓ */
export interface GuessedNote {
  /** What was guessed (a tag or a reader id ✓) */
  what: string;
  /** Why it is a guess ✓ */
  why: string;
  /** Does a human or an agent have to confirm it ✓ */
  needsHuman: boolean;
}

/** The shape of `provenance.json` ("this pack was guessed" has to leave a trace ✓) */
export interface Provenance {
  /** The generic pack it was instantiated from ✓ */
  source: string;
  /** The id of the instantiated pack ✓ */
  targetId: string;
  /** When it was probed ✓ */
  probedAt: string;
  /** How it was connected ✓ */
  connection: ProbeConnection | null;
  /** The guessed ones ✓ */
  guessed: GuessedNote[];
  /** The ones this board does not have ✓ (those are facts too ✓) */
  missing: { readerId: string; detail: string }[];
}

/** The result of the instantiation */
export interface InstantiateResult {
  /** The instantiated pack ✓ */
  pack: BoardPack;
  /** Where it came from ✓ */
  provenance: Provenance;
}

/** The input of the instantiation */
export interface InstantiateOptions {
  /** The generic pack (the recipe ✓) */
  source: BoardPack;
  /** The id of the new pack ✓ (one per board ✓) */
  targetId: string;
  /** The name of the new pack ✓ (for the reader ✓) */
  targetName: string;
  /** The result of the probe ✓ (one per reader ✓) */
  outcomes: ProbeOutcome[];
  /** How it was connected ✓ (optional ✓) */
  connection?: ProbeConnection;
  /** What time it is now (injectable ✓ — easy to test ✓) */
  now?: () => Date;
}

/**
 * `custom.<old id>.` → `custom.<new id>.` ✓
 *
 * → Only the custom namespace is changed ✓ → the tags of the core
 *   vocabulary are never touched ✓
 *   (`cpu.usage` is not custom ✓ — changing it would be changing the
 *   contract ✗).
 */
export function retagCustom(tag: string, fromId: string, toId: string): string {
  const prefix = `custom.${fromId}.`;
  if (!tag.startsWith(prefix)) return tag;
  return `custom.${toId}.${tag.slice(prefix.length)}`;
}

/** The tag prefix of one reader is changed everywhere ✓ */
function retagReader(reader: ReaderDef, fromId: string, toId: string): ReaderDef {
  return {
    ...reader,
    provides: reader.provides.map((p) => ({ ...p, tag: retagCustom(p.tag, fromId, toId) })),
  };
}

/**
 * Which quantities are "guessed" ✓ — the generic pack cannot give
 * the names that are specific to the board ✓.
 *
 * → The grouping of the thermal zones ✓ (the `type_map` is a guess ✓ —
 *   which thermal zone is the SoC is only known from the manual ✓).
 * → The rest: the paths are the conventions of Linux ✓ → not a
 *   guess ✓ (whether it exists ✓ and how many are facts ✓).
 */
function guessedOf(pack: BoardPack): GuessedNote[] {
  const out: GuessedNote[] = [];
  for (const reader of [...pack.readers, ...pack.custom]) {
    if (reader.kind !== 'thermal_zone') continue;
    out.push({
      what: reader.id,
      why:
        '**the grouping of the thermal zones is a guess** — the `type_map` of the generic pack is a guess at "common names" ✓;' +
        '**which thermal zone is the SoC / GPU / NPU can only be known from the manual of this board** ✓',
      needsHuman: true,
    });
  }
  return out;
}

/**
 * The instantiation: the generic pack + the result of the probe → the
 * pack of this board ✓.
 *
 * ── There is only one rule ──
 *
 * → Keep what succeeded, drop what failed ✓
 * → The red ones, but the board really has something else → leave it to
 *   the agent to discover ✓ (do not guess ✓).
 */
export function instantiatePack(opts: InstantiateOptions): InstantiateResult {
  const { source, targetId, targetName, outcomes } = opts;
  const okByReader = new Map<string, ProbeOutcome>();
  for (const o of outcomes) okByReader.set(o.readerId, o);

  // ── 1. Keep the green ones, drop the red ones ✓ ──
  const keep = (reader: ReaderDef): boolean => okByReader.get(reader.id)?.ok === true;

  const readers = source.readers.filter(keep).map((r) => retagReader(r, source.id, targetId));
  const custom = source.custom.filter(keep).map((r) => retagReader(r, source.id, targetId));

  // ── 2. Only the readers that are still there stay in a group ✓; an empty group → the whole group is dropped ✓ ──
  const alive = new Set([...readers, ...custom].map((r) => r.id));
  const pollGroups: PollGroupDef[] = [];
  for (const group of source.poll_groups) {
    const kept = group.readers.filter((rid) => alive.has(rid));
    if (kept.length === 0) continue;
    pollGroups.push({ id: group.id, interval_ms: group.interval_ms, readers: kept });
  }

  // ── 3. The actions: keep them ✓ (the actions are not probed ✓ — they can only be tried on the write side ✓) ──
  const actions = source.actions;

  const pack: BoardPack = {
    apiVersion: source.apiVersion,
    kind: 'BoardPack',
    id: targetId,
    name: targetName,
    version: source.version,
    description:
      `**the first-draft pack found automatically** ✓ (instantiated from the generic pack "${source.id}" ✓) — ` +
      '**what it states accurately are facts** ✓ (whether it exists ✓ · how many ✓),' +
      '**what it states inaccurately are the names and the semantics** ⚠️ (which thermal zone is the SoC ✓ · that an agent has to fill in ✓)',
    requires: { ...source.requires },
    ...(source.danger_floor_version !== undefined
      ? { danger_floor_version: source.danger_floor_version }
      : {}),
    // The `match` is deliberately not written ✓ — the model has to be decided by a human ✓ (the generic pack guesses it ✓ · the instantiation guesses it too ✓)
    // → Not written → it does not take part in the automatic detection ✓ → it does not compete with the other packs ✓
    poll_groups: pollGroups,
    readers,
    custom,
    actions,
  };

  // ── 4. The provenance ✓ ──

  const missing = outcomes
    .filter((o) => !o.ok)
    .map((o) => ({ readerId: o.readerId, detail: o.detail }));

  const provenance: Provenance = {
    source: source.id,
    targetId,
    probedAt: (opts.now?.() ?? new Date()).toISOString(),
    connection: opts.connection ?? null,
    guessed: guessedOf(source),
    missing,
  };

  return { pack, provenance };
}

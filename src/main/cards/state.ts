import { statSync } from 'node:fs';
import { matchTagPattern } from '../tags/vocabulary';
import type { TagReading } from '../../shared/tag-reading';
import type { CardManifest } from './manifest';
import type { PackView } from '../tags/pack-view';

/**
 * **The state of a card on the current board** (contract `spec/04` §2.2 ✓ ·
 * ADR-D40 ✓).
 *
 * ── "Cannot be read" and "does not exist" are two different things ──
 *
 * | Field | What it asks |
 * |---|---|
 * | `missing_tags` | the current board pack **does not have this tag at all** ✓ (**at the pattern level** ✓) |
 * | `unreadable_tags` | the pack **has** it, but **it cannot be read right now** ✓ (**at the concrete name level** ✓) |
 *
 * → **What collapsing them into one field would cause** ✓:
 * "the whole `cpu` reader is down → the wildcard instance **does not turn
 *   stale** in the readings ✓ → the reading is still `ok` with the old value ✓
 *   → the card is **not judged degraded** ✓ → **the agent is fooled** ✓".
 *
 * → So they **have to be separated** ✓.
 *
 * ── "A wildcard instance is absent from the readings" is not "missing" ──
 *
 * The sampler **does not guess the concrete instance names** per the contract
 * ✓ (only the board knows how many cores `cpu.core.*.usage` has ✓)
 * → on a failure it **does not know which concrete tag to mark** ✓ → it skips
 * it ✓ → **so its absence in the readings cannot be read as "missing"** ✓.
 */

/** The state of a card on the current board (**the copy meant for the agent** ✓) */
export interface CardState {
  /** **card id = the name of the card directory** ✓ (everything on the host side is indexed by it ✓) */
  id: string;
  /** The id declared in the manifest (**it may differ from the directory name** ✓ → so there are two fields ✓) */
  manifest_id: string;
  name: string;
  version: string;
  /** The **absolute path** of the card directory ✓ */
  path: string;
  /**
     * **The last modification time of the card directory** (milliseconds, UTC) ✓.
     *
     * → **It is not "the moment the person clicked install"** ✓ — the host
     *   **never recorded an install time** ✓.
     * → **It says what it is** ✓ — otherwise the agent would sort by it to find
     *   "the most recently installed cards" ✗ (that would be wrong) ✗.
     */
  installed_at: number;
  /** `ok` / `degraded` / `invalid` (closed ✓) */
  status: 'ok' | 'degraded' | 'invalid';
  /** Is this card **broken** on the current board ✓ */
  degraded: boolean;
  /** The tags it reads that the **current board pack does not have at all** (**at the pattern level** ✓) */
  missing_tags: string[];
  /** The tags that are declared, that the pack also provides, but that **cannot be read right now** (**at the concrete name level** ✓) */
  unreadable_tags: string[];
}

/** What is needed to compute the state of a card */
export interface CardStateInput {
  /** The card in the registry of the host (**the directory name is the id** ✓) */
  cardId: string;
  dir: string;
  manifest: CardManifest;
  /** The problems of this card (**error level = the manifest is invalid** ✓) */
  issues: { severity: 'error' | 'warning' }[];
  /** The view of the current board pack (**`null` when there is none** ✓ — then there is no such thing as "not on the board at all" ✓) */
  pack: PackView | null;
  /** The current readings (**only the concrete names are judged** ✓) */
  readings: TagReading[];
}

/**
 * **The criterion at the pattern level**: is this pattern `P` provided by the
 * current pack ✓.
 *
 * → **What is judged is "does a provides pattern of the pack cover P"** ✓ —
 *   and not "is it in the readings" ✓ (being in the readings is the
 *   **"cannot be read"** case ✓ — the two readings must not be mixed ✓).
 *
 * → **The criterion of coverage**: the same number of segments ✓ and
 *   **segment by segment**:
 * - both segments literal → they have to be equal ✓
 * - one segment is a wildcard → it **covers** ✓ (`cpu.*.usage` covers
 *   `cpu.core.usage` ✓)
 * - both segments literal but different → it does not cover ✓
 *
 * → **Mind the direction** ✓: `cpu.core.*.usage` does **not** cover `cpu.usage`
 * ✓ (a different number of segments ✓).
 */
export function patternCovered(provided: string, wanted: string): boolean {
  const ps = provided.split('.');
  const ws = wanted.split('.');
  if (ps.length !== ws.length) return false;
  for (let i = 0; i < ps.length; i += 1) {
    const p = ps[i] as string;
    const w = ws[i] as string;
    if (p === '*' || w === '*') continue;
    if (p !== w) return false;
  }
  return true;
}

/** Is a pattern provided by the current pack ✓ */
function isProvided(pack: PackView | null, wanted: string): boolean {
  if (pack === null) return true; // **No pack -> do not judge "the board does not have it"** ✓
  for (const reader of pack.readers) {
    for (const tag of reader.provides) {
      if (patternCovered(tag, wanted)) return true;
    }
  }
  return false;
}

/**
 * **The tags this card wants that the board does not have at all** (**at the
 * pattern level** ✓).
 *
 * → **The pattern itself is recorded** ✓ — **it is not expanded into concrete
 *   names** ✓ (the host has **no "pattern → concrete name" function** ✓ —
 *   only the other direction ✓ — no guessing ✓).
 */
export function missingTags(manifest: CardManifest, pack: PackView | null): string[] {
  const out: string[] = [];
  for (const pattern of manifest.permissions.read) {
    if (!isProvided(pack, pattern)) out.push(pattern);
  }
  return out;
}

/**
 * **The tags that are declared, that the pack provides, but that cannot be
 * read right now** (**at the concrete name level** ✓).
 *
 * → **Only the ones that are in the readings are listed** ✓ — a wildcard
 *   instance that is **absent** from the readings is **not** listed ✓ (that is
 *   "not on the board / not sampled yet" ✓ — not "cannot be read" ✓).
 * → The criterion: **the concrete name is in the readings** ✓ **and its state
 *   is not `ok`** ✓.
 */
export function unreadableTags(
  manifest: CardManifest,
  _pack: PackView | null,
  readings: TagReading[],
): string[] {
  const out: string[] = [];
  for (const reading of readings) {
    if (reading.status === 'ok') continue;
    // **Does this card want to read it** ✓ — judged by pattern coverage ✓
    const wanted = manifest.permissions.read.some((p) => matchTagPattern(p, reading.tag));
    if (!wanted) continue;
    out.push(reading.tag);
  }
  return out;
}

/**
 * **Computes the state of a card on the current board** ✓.
 *
 * → **The three values of `status`** ✓:
 * | Value | When |
 * |---|---|
 * | `invalid` | **the manifest itself is invalid** ✓ (there is an error-level problem ✓) |
 * | `degraded` | the manifest is valid ✓ **but** a tag cannot be read ✓ (or there is a warning ✓) |
 * | `ok` | clean ✓ |
 *
 * → **A card with `invalid` is still listed** ✓ — the agent has to know "the
 * card I installed last time is broken" ✓.
 */
export function cardState(input: CardStateInput): CardState {
  const hasError = input.issues.some((i) => i.severity === 'error');
  const hasWarning = input.issues.some((i) => i.severity === 'warning');

  const missing = missingTags(input.manifest, input.pack);
  const unreadable = unreadableTags(input.manifest, input.pack, input.readings);
  const degraded = missing.length > 0 || unreadable.length > 0;

  const status: CardState['status'] = hasError ? 'invalid' : degraded || hasWarning ? 'degraded' : 'ok';

  return {
    id: input.cardId,
    manifest_id: input.manifest.id,
    name: input.manifest.name,
    version: input.manifest.version,
    path: input.dir,
    installed_at: dirModifiedAt(input.dir),
    status,
    degraded,
    missing_tags: missing,
    unreadable_tags: unreadable,
  };
}

/**
 * **The last modification time of the card directory** (milliseconds, UTC) ✓.
 *
 * → **When it cannot be obtained it is `0`** ✓ (no guessing ✓ — the directory
 *   was deleted ✓ / the permissions are not enough ✓).
 */
export function dirModifiedAt(dir: string): number {
  try {
    return Math.trunc(statSync(dir).mtimeMs);
  } catch {
    return 0;
  }
}

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { isSafeCardId, parseManifest } from '../cards/manifest';
import type { CardRegistry } from '../cards/registry';
/** The **minimal view** of an action (**only the few fields the installation needs** ✓ — not the whole definition ✓) */
export interface PackActionView {
  id: string;
  danger: 'reversible' | 'destructive';
  label?: string;
  guard?: Record<string, { min?: number; max?: number }>;
}

/**
 * **Installing and uninstalling a card** (contract `spec/04` §2.3 ✓ ·
 * ADR-D40 ✓).
 *
 * ── Installing = copying the directory + triggering the hot reload ✓ ──
 *
 * → **Copied into the user card root** ✓ (**not into the built-in directory** ✓
 *   — the built-in one lives in the application directory ✓ and is read-only ✓).
 * → **Installing the same id again = replacing it** ✓ (contract §2.3 ✓ — **not
 *   adding a second one** ✓).
 *
 * ── **Installing a card does not need a "consent" any more** ✓ (contract §2.3
 *   · ADR-D46 ✓) ──
 *
 * → **The board pack has the last word** ✓: **what the board can do is
 *   declared by the board pack** ✓; **what this card can do is declared by
 *   its manifest** ✓ — **the session layer keeps it** ✓
 *   (**anything outside the declaration is denied** ✓ — **a card that says
 *   one thing and does another is not allowed** ✓).
 * → **The user clicking once is the consent** ✓ → there is **no second
 *   "did you authorise this card"** any more ✓.
 * → **The route through a card has no "asking"** ✓ (**a click is the
 *   consent** ✓ — ADR-D46 ✓); **the route through an agent still has to
 *   ask** ✓ (**an agent is not a person** ✓).
 */
export interface CardToolDeps {
  /** The user card root (**the cards are installed here** ✓) */
  cardsRoot: string;
  /** The card registry (**the reload** ✓) */
  registry: CardRegistry;
  /** The actions declared by the current board pack (**to judge "does this action exist"** ✓) */
  packActions?: () => PackActionView[];
  /**
   * **Is a board pack bound right now?** ✓
   *
   * → **No board → the check of the actions is skipped** ✓ (contract §9
   *   rule 5 ✓: "this check is skipped when the board cannot be reached" ✓)
   *   → the card is installed ✓ and marked **degraded** ✓ (nothing was
   *   verified ✓).
   * → Without this the host cannot tell "the pack does not declare it" ✗ from
   *   "there is no pack at all" ✗ → **the two answers were the same** ✗
   *   (found on 2026-11-21 ✓).
   */
  hasBoardPack?: () => boolean;
  /** The ids of the built-in cards (**a built-in card may not be deleted** ✓) */
  builtinIds?: string[];
}

/** The result of an installation (the three shapes of contract §2.3 ✓) */
export interface InstallCardResult {
  ok: boolean;
  installed: boolean;
  card_id?: string;
  degraded?: boolean;
  missing?: string[];
  reason?: 'invalid_params' | 'not_found' | 'invalid' | 'failed';
  detail?: string;
}

/** The result of an uninstallation */
export interface UninstallCardResult {
  ok: boolean;
  reason?: 'not_found' | 'denied' | 'failed';
  detail?: string;
}

/**
 * **Installs a card** (contract §2.3 ✓).
 *
 * @param path the card directory (**an absolute path** ✓)
 */
export function installCard(deps: CardToolDeps, path: string): InstallCardResult {
  const manifestPath = join(path, 'manifest.json');
  // **No manifest → not installed** ✓ (**not "install an empty card"** ✓)
  if (!existsSync(manifestPath)) {
    return { ok: false, installed: false, reason: 'invalid', detail: 'No manifest.json in this directory' };
  }

  // ── Parse the manifest ──
  let manifest;
  try {
    manifest = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown, path);
  } catch (err) {
    return {
      ok: false,
      installed: false,
      reason: 'invalid',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const cardId = manifest.id;
  const target = join(deps.cardsRoot, cardId);

  // ── **The id must be a safe directory name** ✓ ──
  //
  // → The parser already rejects the other shapes ✓ (`parseManifest` ✓ — the
  //   closed shape ✓ · one implementation ✓) → this is the **second lock on
  //   the same door** ✓ → the host deletes a whole directory tree here ✓
  //   (rmSync recursive ✓) → the check has to be **before** that ✓ (found on
  //   2026-11-21 ✓: `"id": ".."` deleted the user data directory ✓).
  if (!isSafeCardId(cardId)) {
    return {
      ok: false,
      installed: false,
      reason: 'invalid',
      detail: `The card id "${cardId}" is not a name of letters, digits and hyphens`,
    };
  }

  // → **And the path has to be inside the card root** ✓ (the third lock ✓ —
  //   it does not trust the id ✓ · it looks at the path that was built ✓).

  // ── **The target must be inside the card root** ✓ ──
  //
  // → The id is checked ✓ → this is the **third lock** ✓ → and it does not
  //   trust the id at all ✓ (it looks at the path that was built ✓).
  if (!isInside(deps.cardsRoot, target)) {
    return {
      ok: false,
      installed: false,
      reason: 'invalid',
      detail: 'The card would be installed outside the card root',
    };
  }

  // ── The source must be a directory that is not enormous ✓ ──
  //
  // → The path comes from the agent ✓ → it may point at anything on the
  //   disk ✓ → **copying it is a copy of everything there** ✗ (a denial of
  //   service ✓ · and the copy lands in the card root ✓ where the agent can
  //   read it again ✓).
  const size = measureDirectory(path);
  if (!size.readable) {
    return {
      ok: false,
      installed: false,
      reason: 'invalid',
      detail: 'The card directory cannot be read',
    };
  }
  if (size.tooBig) {
    return {
      ok: false,
      installed: false,
      reason: 'invalid',
      detail:
        `The card is too big to install (${size.files} files, ${size.bytes} bytes — ` +
        `the limit is ${MAX_CARD_FILES} files and ${MAX_CARD_BYTES} bytes)`,
    };
  }

  // ── **Do the actions this card wants to write really exist** ✓ (**the board pack has the last word** ✓) ──
  // → **They do not exist → it cannot be installed** ✓ (**installing a card that is half empty is not done** ✓ — contract §2.3 ✓)
  // → **No board pack at all → the check is skipped** ✓ (contract §9 rule 5 ✓
  //   — "this check is skipped when the board cannot be reached" ✓) → the
  //   card is installed ✓ and it is **degraded** ✓ (nothing was verified ✓).
  const offline = deps.hasBoardPack !== undefined && !deps.hasBoardPack();
  const known = new Set((deps.packActions?.() ?? []).map((a) => a.id));
  const missing = manifest.permissions.write.filter((id) => !known.has(id));
  if (missing.length > 0 && !offline) {
    return {
      ok: false,
      installed: false,
      card_id: cardId,
      reason: 'invalid',
      detail: `The board pack does not declare these actions: ${missing.join(', ')}`,
    };
  }

  const installed = doInstall(deps, path, target, cardId);
  if (!installed.ok) return installed;
  // → **Offline → nothing was verified** ✓ → the card is degraded ✓ (the
  //   same word as the other "not everything works" case ✓).
  return { ...installed, degraded: offline, missing: [] };
}

/**
 * **Is the target inside the root?** ✓
 *
 * → `relative` ✓ — an empty result means the target **is** the root ✓ (that
 *   is not allowed either ✓ → the check below rejects it ✓).
 */
function isInside(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  if (relativePath.length === 0) return false;
  if (isAbsolute(relativePath)) return false;
  return !relativePath.split(/[\\/]/).includes('..');
}

/** The limits of a card directory ✓ (a card is a few files ✓) */
const MAX_CARD_FILES = 2000;
const MAX_CARD_BYTES = 16 * 1024 * 1024;

/**
 * How big is the directory? ✓
 *
 * → `readable` = it could be walked ✓ · `tooBig` = it is over the limits ✓
 *   (the walk stops there ✓ — it does not count a hundred gigabytes ✓).
 */
function measureDirectory(dir: string): {
  files: number;
  bytes: number;
  readable: boolean;
  tooBig: boolean;
} {
  let files = 0;
  let bytes = 0;
  let readable = true;
  let tooBig = false;
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      readable = false;
      return;
    }
    for (const entry of entries) {
      if (tooBig || !readable) return;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      files += 1;
      try {
        bytes += statSync(path).size;
      } catch {
        readable = false;
        return;
      }
      if (files > MAX_CARD_FILES || bytes > MAX_CARD_BYTES) {
        tooBig = true;
        return;
      }
    }
  };
  walk(dir);
  return { files, bytes, readable, tooBig };
}

/** **Really installs it** ✓ — copies the directory + reloads ✓ */
function doInstall(
  deps: CardToolDeps,
  path: string,
  target: string,
  cardId: string,
): InstallCardResult {
  try {
    mkdirSync(deps.cardsRoot, { recursive: true });
    // **Installing the same id again = replacing it** ✓ (contract §2.3 ✓) → **the old one is deleted first** ✓
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    cpSync(path, target, { recursive: true });
    // **The hot reload** ✓ (the directory changed ✓ → the watcher notices it ✓ → it is refreshed once more here ✓ so that one does not have to wait for that tick ✓)
    deps.registry.refresh();
    return { ok: true, installed: true, card_id: cardId, degraded: false, missing: [] };
  } catch (err) {
    return {
      ok: false,
      installed: false,
      card_id: cardId,
      reason: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * **Uninstalls a card** (contract §2.3 ✓).
 *
 * → **Only the ones under the user card root** ✓ (**a built-in card cannot be
 *   deleted** ✓ — it lives in the application directory ✓).
 * → **There is no authorisation ledger to clear** ✓ (**it was removed on
 *   2026-11-16** ✓ — ADR-D46 ✓) → **the manifest is the authorisation** ✓.
 */
export function uninstallCard(deps: CardToolDeps, cardId: string): UninstallCardResult {
  // **A built-in card → it may not be deleted** ✓
  if ((deps.builtinIds ?? []).includes(cardId)) {
    return { ok: false, reason: 'denied', detail: 'Builtin cards cannot be removed' };
  }
  const dir = deps.registry.dirOf(cardId);
  if (dir === null) {
    return { ok: false, reason: 'not_found', detail: `No such card: ${cardId}` };
  }
  try {
    rmSync(dir, { recursive: true, force: true });
    // **There is no authorisation ledger to clear** ✓ (**it was removed on 2026-11-16** ✓ — ADR-D46 ✓)
    deps.registry.refresh();
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

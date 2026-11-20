import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseManifest } from '../cards/manifest';
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

  // ── **Do the actions this card wants to write really exist** ✓ (**the board pack has the last word** ✓) ──
  // → **They do not exist → it cannot be installed** ✓ (**installing a card that is half empty is not done** ✓ — contract §2.3 ✓)
  const known = new Set((deps.packActions?.() ?? []).map((a) => a.id));
  const missing = manifest.permissions.write.filter((id) => !known.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      installed: false,
      card_id: cardId,
      reason: 'invalid',
      detail: `The board pack does not declare these actions: ${missing.join(', ')}`,
    };
  }

  return doInstall(deps, path, target, cardId);
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
 * → **The authorisation ledger is cleared as well** ✓ (otherwise installing
 *   it again would bring the old authorisation along ✗ — that would not be a
 *   "fresh install" ✓).
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

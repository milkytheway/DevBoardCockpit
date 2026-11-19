import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Path resolution.
 *
 * The rule (AGENTS.md section 3): write absolute paths; the Windows host
 * uses `C:\...`. Machine-specific paths appear only here and in
 * `profiles/settings.json`, never in the code (device fact list in `docs/`,
 * section 2).
 */

const DEFAULT_APP = 'DevBoardCockpit';

/** The user data directory: %LOCALAPPDATA% on Windows, the XDG convention elsewhere */
export function userDataDir(appName: string = DEFAULT_APP): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData && localAppData.length > 0) {
    return join(localAppData, appName);
  }
  if (process.platform === 'win32') {
    // Fall back to the home directory when LOCALAPPDATA is missing on Windows
    return join(homedir(), 'AppData', 'Local', appName);
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), appName);
}

/** The built-in connection profile directory (shipped with the app, read-only) */
export function builtinProfilesDir(appRoot: string): string {
  return join(appRoot, 'profiles', 'targets');
}

/** The user's own connection profile directory (writable) */
export function userProfilesDir(appName: string = DEFAULT_APP): string {
  return join(userDataDir(appName), 'profiles', 'targets');
}

/**
 * The card root directory (the user's own copy).
 *
 * Both the human's cards and the agent's cards go here.
 */
export function cardRootsDir(appName: string = DEFAULT_APP): string {
  return join(userDataDir(appName), 'cards');
}

/**
 * The built-in card directory (the batch shipped with the app).
 *
 * → Same idea as the `profiles/` ones: it comes with the app, and it is
 *   read-only.
 */
export function builtinCardsDir(appRoot: string): string {
  return join(appRoot, 'cards');
}

/**
 * The card storage directory.
 *
 * ── It has to be a sibling directory, not nested inside the card root ──
 *
 * The card root is watched by `fs.watch` (hot plug). Writing the storage
 * inside the root means one `storage.json` write triggers a `refresh` plus
 * `cardsChanged`, the page fetches the manifest again, and the loop is
 * closed.
 *
 * → So the storage goes into `card-storage/`, at the same level as `cards/`.
 */
export function cardStorageDir(appName: string = DEFAULT_APP): string {
  return join(userDataDir(appName), 'card-storage');
}

/**
 * The built-in workflow pack directory (the batch shipped with the app).
 *
 * → It sits together with `profiles/boards/` (board packs) and
 *   `profiles/targets/` (connection profiles): all host-side data files live
 *   under `profiles/`.
 */
export function builtinWorkflowsDir(appRoot: string): string {
  return join(appRoot, 'profiles', 'workflows');
}

/**
 * The user's own workflow pack directory (being here does not mean it can
 * run — whether it can run depends on the permission area).
 *
 * → Same reasoning as for the card directory: being there only makes it a
 *   candidate. The gate is the unified permission area in the settings
 *   (`docs/spec/03-card-manifest.md` section 2.4 · implementation-layer
 *   decision record ADR-D47).
 */
export function userWorkflowsDir(appName: string = DEFAULT_APP): string {
  return join(userDataDir(appName), 'workflows');
}

/**
 * The user's own board pack directory (writable).
 *
 * ── Why it did not exist before (it was added on 2026-11-19) ──
 *
 * → The board pack was the only one of them with a built-in copy only and
 *   no user copy, while the connection profile (`userProfilesDir`), the
 *   cards (`cardRootsDir`) and the workflow packs (`userWorkflowsDir`) all
 *   have two copies.
 * → Consequence: a board pack that the user drops into the user data
 *   directory is not read at runtime (the runtime reads only the one inside
 *   the asar — `src/main/index.ts:210`), so a pack instantiated by the
 *   wizard is dead on arrival once it lands.
 * → So it was added, following the same rule as the other three (the user
 *   directory comes second, so on the same id the user's copy wins).
 */
export function userBoardsDir(appName: string = DEFAULT_APP): string {
  return join(userDataDir(appName), 'boards');
}

/** The session log directory */
export function logDir(appName: string = DEFAULT_APP): string {
  return join(userDataDir(appName), 'logs');
}

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Host settings.
 *
 * Machine-specific paths appear only here and in `profiles/settings.json`,
 * never in the code (device fact list in `docs/`, section 2: the host `adb`
 * is not on PATH, and `where adb` cannot find it).
 */

export interface HostTools {
  /** Absolute path of the adb executable. null = let the runtime look along PATH, then at the usual locations */
  adb: string | null;
}

export interface AppSettings {
  name: string;
  dataDirName: string;
}

export interface Settings {
  hostTools: HostTools;
  app: AppSettings;
}

const DEFAULT_SETTINGS: Settings = {
  hostTools: { adb: null },
  app: { name: 'DevBoardCockpit', dataDirName: 'DevBoardCockpit' },
};

/**
 * The path of the settings file (one entry point — the CLI and the app must
 * not each look for their own).
 *
 * ── Why it is centralised ──
 *
 * Before: the app used `join(app.getAppPath(), 'profiles', 'settings.json')`
 * while the CLI (`scripts/run-workflow.ts` and friends) did not read the
 * settings at all, so `adbPath` was `undefined` when the CLI opened a
 * connection, fell back to `'adb'`, the host `adb` is not on PATH, and
 * `spawn adb ENOENT` was the result. The "compile onto the board" workflow
 * simply could not run in the CLI, while in the app it worked fine — two
 * versions of the truth, a trap this project has fallen into several times
 * before.
 *
 * → Now whoever opens a connection resolves the adb path the same way.
 *
 * @param root The root directory. The app passes `app.getAppPath()`; the CLI
 * passes the cwd.
 */
export function settingsPath(root?: string): string {
  return join(root ?? process.cwd(), 'profiles', 'settings.json');
}

/**
 * Reads `profiles/settings.json`.
 *
 * A missing or broken file yields the defaults — unreadable settings must
 * not keep the app from starting.
 */
export function loadSettings(settingsPath: string): Settings {
  try {
    const raw = readFileSync(settingsPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SETTINGS;
    const obj = parsed as Record<string, unknown>;
    const tools = (obj['hostTools'] ?? {}) as Record<string, unknown>;
    const app = (obj['app'] ?? {}) as Record<string, unknown>;
    return {
      hostTools: {
        adb: typeof tools['adb'] === 'string' ? tools['adb'] : null,
      },
      app: {
        name: typeof app['name'] === 'string' ? app['name'] : DEFAULT_SETTINGS.app.name,
        dataDirName:
          typeof app['dataDirName'] === 'string'
            ? app['dataDirName']
            : DEFAULT_SETTINGS.app.dataDirName,
      },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * Locates the adb executable.
 *
 * The order is: the absolute path from `settings.json`, then PATH, then the
 * usual install locations. If none of them matches, return 'adb' and let
 * spawn report "not found" — that is an error a human can read.
 */
export function resolveAdbPath(settings: Settings): string {
  const configured = settings.hostTools.adb;
  if (configured && existsSync(configured)) return configured;

  // The usual install locations (on this machine adb lives under Downloads)
  const common = [
    join(process.env['USERPROFILE'] ?? '', 'Downloads', 'platform-tools', 'adb.exe'),
    join(process.env['USERPROFILE'] ?? '', 'AppData', 'Local', 'Android', 'Sdk',
      'platform-tools', 'adb.exe'),
  ];
  for (const p of common) {
    if (p && existsSync(p)) return p;
  }
  // Versioned directory names such as `platform-tools_r33.0.3-windows` —
  // measured: the adb on this machine is in there, while the unversioned
  // path does not exist. Downloads is scanned once with `readdirSync` (no
  // glob: globbing would mean adding a dependency).
  try {
    const downloads = join(process.env['USERPROFILE'] ?? '', 'Downloads');
    const candidates = readdirSync(downloads)
      .filter((name) => name.startsWith('platform-tools'))
      .map((name) => join(downloads, name, 'platform-tools', 'adb.exe'));
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  } catch {
    // If the directory cannot be read, move on — this is the last resort
  }
  return 'adb';
}

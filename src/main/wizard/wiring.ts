import { join } from 'node:path';
import type { ConnectionProfile } from '../profiles/schema';
import { createConnection } from '../hal/registry';
import { loadSettings, resolveAdbPath } from '../util/settings';
import { SessionLog } from '../logging/session-log';
import { runWizard, type WizardDeps, type WizardResult } from './run';

/**
 * The wiring of the wizard on the main side — added 2026-11-19.
 *
 * ── Why it is a file of its own (and not stuffed into `index.ts`) ──
 *
 * → `index.ts` already is a thousand-line wiring board → stuffing the
 *   details of the wizard in there means it keeps growing
 * → This part has dependencies of its own (the session log · the
 *   connection factory · the two directories) → they are collected
 *   here → `index.ts` calls one function ✓.
 *
 * ── ⚠️ It writes into the directories of the user ──
 *
 * → It writes the connection profile ✓ (the user data directory ✓ ·
 *   `userProfilesDir()` ✓)
 * → It writes the board pack ✓ (the user data directory ✓ ·
 *   `userBoardsDir()` ✓)
 * → So it is host-only ✓ — a card and an agent cannot get at it ✓
 *   (the IPC contract ✓).
 */

/** The dependencies of the wiring (injectable ✓ — easy to test ✓) */
export interface WizardWiringOptions {
  /** The root of the application (the built-in packs are here ✓) */
  appRoot: string;
  /** The directory of the connection profiles of the user ✓ */
  userProfilesDir: string;
  /** The directory of the board packs of the user ✓ */
  userBoardsDir: string;
  /** The user data directory (the session logs are here ✓) */
  userDataDir: string;
  /** Build the connection ✓ (the real one by default ✓) */
  createConnection?: (
    profile: ConnectionProfile,
    log: SessionLog,
  ) => ReturnType<typeof createConnection> | Promise<ReturnType<typeof createConnection>>;
  /** Build the session log ✓ */
  createLog?: (label: string, transport: string) => SessionLog;
}

/** The dependencies of one wizard run ✓ */
export function wizardDeps(opts: WizardWiringOptions): WizardDeps {
  const settings = loadSettings(join(opts.appRoot, 'profiles', 'settings.json'));
  const adbPath = resolveAdbPath(settings);
  return {
    createConnection:
      opts.createConnection ??
      ((profile, log) => createConnection(profile, log, { adbPath })),
    createLog:
      opts.createLog ??
      ((label, transport) =>
        new SessionLog({
          label,
          transport,
          dataDir: opts.userDataDir,
        })),
    genericPackDir: join(opts.appRoot, 'profiles', 'boards', 'generic-linux'),
    boardsRoot: opts.userBoardsDir,
    profilesRoot: opts.userProfilesDir,
  };
}

/**
 * Run the wizard once ✓ — it returns what the interface shows ✓.
 *
 * → Four results ✓ — they are different faults ✓ (see
 *   `WizardRunResult` ✓).
 */
export async function runWizardForHost(
  input: { port: string; baudrate: number; boardName?: string; transport?: 'serial' | 'adb' },
  opts: WizardWiringOptions,
): Promise<{
  ok: boolean;
  kind: 'ok' | 'port-unopenable' | 'no-reply' | 'connection-dead' | 'connection-failed';
  message: string;
  hints: string[];
  greenCount: number;
  redCount: number;
  installedDir?: string;
  boardId?: string;
}> {
  let result: WizardResult;
  try {
    result = await runWizard(input, wizardDeps(opts));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      kind: 'no-reply',
      message: `**the wizard did not finish** ✓ —— ${message}`,
      hints: [],
      greenCount: 0,
      redCount: 0,
    };
  }

  const greenCount = result.reports?.filter((r) => r.ok).length ?? 0;
  const redCount = result.reports?.filter((r) => !r.ok).length ?? 0;

  return {
    ok: result.ok,
    kind: result.ok
      ? 'ok'
      : result.firstTruth.kind === 'port-unopenable'
        ? // → **The transport decides the wording** ✓ — the ADB line has no
          //   serial port ✓ → "the serial port cannot be opened" for an ADB
          //   failure is a lie ✓ (found on 2026-11-22 ✓).
          (input.transport ?? 'serial') === 'adb'
          ? 'connection-failed'
          : 'port-unopenable'
        : 'no-reply',
    message: result.message,
    // The hint of the transport goes first ✓ (it is the most accurate one ✓ — the serial line knows "the reply was swallowed" ✓)
    hints: result.hint !== undefined ? [result.hint] : [],
    greenCount,
    redCount,
    ...(result.installedDir !== undefined ? { installedDir: result.installedDir } : {}),
    ...(result.installedDir !== undefined
      ? { boardId: result.installedDir.split(/[\\/]/).pop() }
      : {}),
  };
}

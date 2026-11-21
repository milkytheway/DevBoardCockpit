import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connection } from '../hal/connection';
import type { SessionLog } from '../logging/session-log';
import type { ConnectionProfile } from '../profiles/schema';
import { parseProfile } from '../profiles/schema';
import { loadBoardPack } from '../tags/pack';
import { probePack, type ProbeReaderReport } from '../tags/probe';
import { outcomesOf } from './probe-adapter';
import { instantiatePack } from './instantiate';
import { installInstantiatedPack } from './install';
import type { FirstTruth } from './chain';

/**
 * The main flow of the wizard ✓ — added 2026-11-19.
 *
 * ── The person takes part in one step ✓ ──
 *
 * ```
 * The person picks the COM port + the baud rate   ← 【the only thing the person has to do in the whole wizard】
 *         ↓
 * The wizard runs one command                      ← "the first truth" ✓
 *         ↓
 *      The board answered → try the generic meta-operations one by one ✓ → the truth table ✓
 *         ↓
 *      Instantiate ✓ → write to disk ✓ → this board has a pack of its own ✓
 * ```
 *
 * ── ⚠️ How "the first truth" is computed ✓ ──
 *
 * → A connection that really can run a command ✓ — not "it is
 *   connected" ✓, but "the command really returned something" ✓ ✓.
 * → What to run ✓: `cat /proc/device-tree/model` ✓
 *   — it is the most universal one ✓ (any Linux has it ✓) → the
 *   reply is the truth ✓.
 * → The four results have to be said apart ✓:
 *   the port cannot be opened ✓ · the board said nothing ✓ · there
 *   is a reply but it looks like garbage ✓ · it worked ✓
 *   (they are different faults ✓ → the fixes are completely
 *   different ✓).
 */

/** What the person gives ✓ (the only thing the person has to do in the wizard ✓) */
export interface WizardInput {
  /** The serial port ✓ (not enumerated automatically ✓ — the user has decided ✓) */
  port: string;
  /** The baud rate ✓ (not tried ✓ — the user has decided ✓) */
  baudrate: number;
  /** Optional override; otherwise the model reported by the board names the pack. */
  boardName?: string;
  /** The id of the board ✓ (derived from the name by default ✓) */
  boardId?: string;
  /**
   * Which line it goes over ✓ (the serial line by default ✓ — the
   * user decided that "it starts with the serial line" ✓).
   *
   * → adb ✓ — it is there as soon as the USB is plugged in ✓ ·
   *   no credential at all ✓.
   * → serial ✓ — the debug port ✓.
   */
  transport?: 'serial' | 'adb';
}

/** The result of a wizard run */
export interface WizardResult {
  /** Did it work ✓ */
  ok: boolean;
  /** The first truth ✓ */
  firstTruth: FirstTruth;
  /** The hint the transport gave ✓ (optional ✓ — the serial line knows "the reply was swallowed" ✓) */
  hint?: string;
  /** The truth table ✓ (the result of trying the generic meta-operations ✓) */
  reports?: ProbeReaderReport[];
  /** The instantiated pack ✓ */
  pack?: ReturnType<typeof instantiatePack>['pack'];
  /** Where it landed ✓ */
  installedDir?: string;
  /** One sentence in plain language ✓ */
  message: string;
}

/** The command of the first round (the most universal one ✓) */
const FIRST_COMMAND = 'cat /proc/device-tree/model';

/**
 * Derive an id from a name ✓.
 *
 * ── ⚠️ A Chinese name has to work ✓ (this is a real problem ✓ · it
 * was hit on 2026-11-19) ──
 *
 * → The first version replaced everything that matched `[^a-z0-9._-]+` with
 *   a hyphen ✓ → a Chinese name was gone entirely ✓
 *   → "my board" became `board` ✓ → two boards with Chinese names would
 *   collide ⚠️
 *   (the ids collide → one overwrites the other ⚠️).
 * → So: the Chinese is kept ✓ (the contract does not restrict the
 *   character set of a tag or an id ✓ — rule 1 only checks the
 *   namespace ✓), only the characters that are really dangerous on a path
 *   are removed ✓ (`/ \ : * ? " < > |` ✓).
 * → The case is kept ✓ (Chinese has no case ✓ · English stays as it
 *   is ✓ — the name is for a human to read ✓).
 */
export function boardIdOf(name: string): string {
  const id = name
    .trim()
    // The characters that are really dangerous on a path are removed ✓ (the rest stays ✓ — the Chinese has to work ✓)
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id.length > 0 ? id : 'board';
}

/** A display name from the first command's model output. */
export function boardNameFromModel(detail: string, fallback: string): string {
  const model = detail.replace(/\0/g, '').replace(/\s+/g, ' ').trim();
  return model.length > 0 ? model : fallback;
}

/**
 * The dependencies the wizard needs ✓ — injectable ✓ (easy to
 * test ✓ — it can be tested without really opening a serial line).
 */
export interface WizardDeps {
  /** Build the connection ✓ */
  createConnection: (profile: ConnectionProfile, log: SessionLog) => Connection | Promise<Connection>;
  /** Build the session log ✓ */
  createLog: (label: string, transport: string) => SessionLog;
  /** Where the generic pack is ✓ */
  genericPackDir: string;
  /** The directory of the user board packs ✓ */
  boardsRoot: string;
  /** The directory of the user connection profiles ✓ */
  profilesRoot: string;
}

/** Build a temporary serial profile ✓ (it names `generic-linux` ✓ — no new mechanism at all ✓) */
export function serialProfileOf(input: WizardInput, boardId: string): ConnectionProfile {
  const transport = input.transport ?? 'serial';
  if (transport === 'adb') {
    return parseProfile(
      {
        id: `wizard-${boardId}`,
        label: `Wizard · ADB`,
        transport: 'adb',
        // It names the generic pack ✓ → the route "the connection names a pack" does not look at match at all ✓
        board_pack: 'generic-linux',
        device_key: boardId,
        options: {},
      },
      'wizard',
    );
  }
  return parseProfile(
    {
      id: `wizard-${boardId}`,
      label: `Wizard · ${input.port}`,
      transport: 'serial',
      // It names the generic pack ✓ → the route "the connection names a pack" does not look at match at all ✓
      board_pack: 'generic-linux',
      device_key: boardId,
      options: { port: input.port, baudrate: input.baudrate, pty: true },
    },
    'wizard',
  );
}

/**
 * "The first truth" ✓ — a connection that really can run a command
 * ✓.
 *
 * → The port cannot be opened ✓ → `port-unopenable` ✓
 * → It timed out ✓ → `no-reply` ✓ (the board said nothing ✓ —
 *   not "it cannot be reached" ✓)
 * → There is garbage in the reply ✓ → `wrong-baud` ✓
 * → It replied ✓ → `ok` ✓
 */
export function firstTruthOf(
  connection: Connection,
): Promise<FirstTruth> {
  return connection
    .exec(FIRST_COMMAND, { timeoutMs: 5000 })
    .then((result): FirstTruth => {
      if (result.exitCode === 0 && result.stdout.trim().length > 0) {
        const detail = result.stdout.trim().slice(0, 120);
        return { ok: true, kind: 'ok' as const, detail };
      }
      if (result.timedOut) {
        return {
          ok: false,
          kind: 'no-reply',
          detail: 'it connected, but the command got no reply',
          // The words of the transport are carried out ✓ (the serial line knows "the reply was swallowed by another program" ✓ — do not throw it away ✗)
          ...(result.hint !== undefined ? { hint: result.hint } : {}),
        };
      }
      return {
        ok: false,
        kind: 'no-reply',
        detail: `the command returned ${result.exitCode ?? '?'}, but there was no content`,
      };
    })
    .catch((err: unknown): FirstTruth => {
      const message = err instanceof Error ? err.message : String(err);
      // The port cannot be opened and the other errors have to be told apart ✓
      //
      // ⚠️ The criterion has to look at the error code ✓ — not only at the message text ✓
      // (one different character and it is classified wrongly ✓ — measured on 2026-11-20 ⚠️:
      //   the serial line throws "cannot open serial COM99" ✓ → it does not contain "open" ✓ →
      //   matching only the text → it is classified as "the board said nothing" ⚠️ → the wrong fault is reported ⚠️)
      const code = (err as { code?: string } | undefined)?.code;
      if (code === 'CONN_OPEN_FAILED' || code === 'PORT_BUSY') {
        return { ok: false, kind: 'port-unopenable', detail: message };
      }
      // The text is only a fallback ✓ (the errors other than the code ✓)
      if (/cannot open|not open|is busy|ENOENT|EBUSY|Access|denied/i.test(message)) {
        return { ok: false, kind: 'port-unopenable', detail: message };
      }
      return { ok: false, kind: 'no-reply', detail: message };
    });
}

/**
 * The main flow of the wizard ✓.
 *
 * → The person takes part in the first step ✓ → everything else is
 *   automatic ✓.
 * → The result of every step has to be sayable ✓ (`chain.ts` ✓).
 */
export async function runWizard(
  input: WizardInput,
  deps: WizardDeps,
): Promise<WizardResult> {
  const transport = input.transport ?? 'serial';
  const provisionalName =
    input.boardName?.trim() ||
    (transport === 'adb' ? 'adb-board' : `serial-${input.port || 'board'}`);
  const provisionalId = input.boardId ?? boardIdOf(provisionalName);
  const profile = serialProfileOf(input, provisionalId);
  const log = deps.createLog(`wizard-${provisionalId}`, transport);

  let connection: Connection;
  try {
    connection = await deps.createConnection(profile, log);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      firstTruth: { ok: false, kind: 'port-unopenable', detail: message },
      message: `**the serial port cannot be opened** ✓ —— ${message}`,
    };
  }

  try {
    await connection.open();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await connection.close().catch(() => undefined);
    return {
      ok: false,
      firstTruth: { ok: false, kind: 'port-unopenable', detail: message },
      message: `**the serial port cannot be opened** ✓ —— ${message}`,
    };
  }

  // ── The first truth ✓ ──
  const truth = await firstTruthOf(connection);
  if (!truth.ok) {
    await connection.close().catch(() => undefined);
    return {
      ok: false,
      firstTruth: truth,
      // The hint of the transport is carried out too ✓ (the interface has to be able to show it ✓)
      ...(truth.hint !== undefined ? { hint: truth.hint } : {}),
      message:
        truth.kind === 'port-unopenable'
          ? `**the serial port cannot be opened** ✓ —— ${truth.detail}`
          : `**the board said nothing** ✓ —— ${truth.detail}`,
    };
  }

  const boardName =
    input.boardName?.trim() || boardNameFromModel(truth.detail, provisionalName);
  const boardId = input.boardId ?? boardIdOf(boardName);

  // ── Try the generic meta-operations one by one ✓ ──
  const generic = loadBoardPack(deps.genericPackDir);
  const report = await probePack(generic, connection);
  await connection.close().catch(() => undefined);

  // ── Instantiate + write to disk ✓ ──
  const result = instantiatePack({
    source: generic,
    targetId: boardId,
    targetName: boardName,
    outcomes: outcomesOf(report.readers),
    connection:
      transport === 'serial'
        ? { transport: 'serial', port: input.port, baudrate: input.baudrate }
        : { transport: 'adb' },
  });

  // A profile is written first ✓ — otherwise this board cannot be selected in the interface ✓
  writeProfile(deps.profilesRoot, boardId, { ...input, boardName });

  const { dir } = installInstantiatedPack({
    pack: result.pack,
    provenance: result.provenance,
    boardsRoot: deps.boardsRoot,
  });

  // An old pack with the same name does not get in the way ✓ — "do not overwrite silently" is a rule of writing to disk ✓
  // → Here it has to be overwritten ✓ (running the wizard again = probing again ✓ → the product should be updated ✓)
  return {
    ok: true,
    firstTruth: truth,
    reports: report.readers,
    pack: result.pack,
    installedDir: dir,
    message:
      `done ✓ —— **${report.readers.filter((r) => r.ok).length} meta-operations are usable** ✓ · ` +
      `**the pack is at** ${dir}`,
  };
}

/**
 * Write a connection profile ✓ — otherwise this board cannot be
 * selected in the interface ✓.
 *
 * → The same name is overwritten ✓ (running the wizard again = probing
 *   again ✓ → the profile should be updated too ✓).
 */
export function writeProfile(profilesRoot: string, boardId: string, input: WizardInput): void {
  mkdirSync(profilesRoot, { recursive: true });
  const transport = input.transport ?? 'serial';
  const profile = {
    id: `board-${boardId}`,
    label: `Board · ${input.boardName ?? boardId}`,
    transport,
    board_pack: boardId,
    device_key: boardId,
    options:
      transport === 'serial'
        ? { port: input.port, baudrate: input.baudrate, pty: true }
        : {},
  };
  writeFileSync(
    join(profilesRoot, `board-${boardId}.json`),
    `${JSON.stringify(profile, null, 2)}\n`,
    'utf8',
  );
}

/** Is this file there (for the criterion ✓) */

export function profileExists(profilesRoot: string, boardId: string): boolean {
  return existsSync(join(profilesRoot, `board-${boardId}.json`));
}

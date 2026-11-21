import { RoundTripQueue } from '../hal/round-trip-queue';
import type { Connection } from '../hal/connection';
import type { SessionLog } from '../logging/session-log';
import type { ConnectionProfile } from '../profiles/schema';
import { deviceKeyOf } from '../profiles/schema';
import type { TagReading } from '../../shared/tag-reading';
import { AppError, type ErrorCode } from '../../shared/errors';
import type { ActionDef, BoardPack } from './schema';
import { matchTagPattern } from './vocabulary';
import { TagStore, type TagSample } from './store';
import { packView, type PackView } from './pack-view';
import type { RuntimeState, RuntimeStatus } from '../../shared/runtime-status';
import { TagSampler } from './sampler';
import { PollScheduler } from './scheduler';
import { resolvePack } from './binding';
import { validatePack, errorsOf } from './validator';

/**
 * The type of the runtime state lives in shared
 * (`src/shared/runtime-status.ts`) — it has to reach the screen over IPC (the
 * panel has to say "why there is no number"), and shared is the only place
 * the IPC types live. It is exported here as well so that the existing
 * imports keep working.
 */
export type { RuntimeState, RuntimeStatus };

/**
 * The tag runtime — it wires the library built in M3/M4 into the
 * application.
 *
 * ── The four things it is responsible for ──
 *
 * | Thing | Why |
 * |---|---|
 * | build the connection → bind the pack → validate → start the scheduler | the four preconditions of "the values move on their own", none of them optional |
 * | the readings enter and leave only through the TagStore | ADR-D22: one state has one copy |
 * | a late subscriber does not miss the current value | a window that opens late should see the current numbers too (contract section 2.1) |
 * | a failure says what it is | "this board has no board pack" and "it cannot be reached" are two different things |
 *
 * ── Whose connection is it? ──
 *
 * The runtime builds a connection of its own, separate from the connection
 * of the terminal tab.
 *
 * The reason: the panel has to have numbers even when there is no terminal
 * tab — "watching the readings of the board" is the main line of this
 * product, the terminal is the accessory.
 *
 * The cost (stated, not hidden): a serial line is exclusive — the runtime
 * and the terminal tab each want a connection and only one of them can have
 * the same COM3. The second one fails (the port is busy), and the failure is
 * visible (not silent). This is a known limit of the serial route, not a bug
 * of this module.
 */

export interface TagRuntimeOptions {
  /** The parent directory of the board pack directories (the built-in one) */
  packsDir: string;
  /**
   * The user's own board pack directory (optional — it is skipped when it
   * does not exist).
   *
   * → On the same id the user's pack wins (the same rule as in
   *   `profiles/loader.ts`).
   */
  userPacksDir?: string;
  /**
   * Build the connection.
   *
   * → **It may be asynchronous** ✓ — before the connection is built, the
   *   machine-specific values of the profile are detected ✓ (the board's
   *   serial number ✓ · its address ✓) → that is a question for the outside
   *   world ✓ → it cannot be answered synchronously ✓.
   */
  createConnection: (profile: ConnectionProfile, log: SessionLog) => Connection | Promise<Connection>;
  /** Build the session log */
  createLog: (label: string, transport: string) => SessionLog;
}

export class TagRuntime {
  private readonly store = new TagStore();
  /**
   * Every round trip goes through this queue (contract section 1.2.1 ·
   * ADR-D23).
   *
   * It is an instance field and not a local variable of `start()` — the
   * action executor has to run "execute + read back" on the same queue, as
   * one exclusive transaction (`runTransaction`); a local queue would be out
   * of reach for the action executor.
   */
  private readonly queue = new RoundTripQueue();
  private readonly listeners: ((reading: TagReading) => void)[] = [];
  private scheduler: PollScheduler | undefined;
  /** The sampler (a directed read needs it) */
  private sampler: TagSampler | undefined;
  private connection: Connection | undefined;
  private state: RuntimeState = 'idle';
  private detail: string | undefined;
  private profileId: string | undefined;
  /**
   * The `device_key` of the board that is bound right now (contract
   * `spec/02` section 10.2).
   *
   * → The physical board and the connection are two layers — one board has
   *   an ADB, a serial and an SSH connection
   * → The credentials are bound to it (contract `spec/04` section 2.4.1, the
   *   sixth item).
   */
  private deviceKey: string | undefined;
  /** The error code of the last failure (the source of `RuntimeStatus.detailCode`) */
  private detailCode: ErrorCode | undefined;
  /** The board pack that is bound right now (the executor looks up the action definitions — `spec/02` section 4) */
  private pack: BoardPack | undefined;

  constructor(private readonly opts: TagRuntimeOptions) {}

  /** The state right now */
  get status(): RuntimeStatus {
    return {
      state: this.state,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
      ...(this.profileId === undefined ? {} : { profileId: this.profileId }),
      ...(this.detailCode === undefined ? {} : { detailCode: this.detailCode }),
    };
  }

  /**
   * Start sampling the readings of one profile.
   *
   * It does not throw — every failure goes into `status`:
   * "this board has no board pack" and "it cannot be reached" are two
   * different things, and the user has to see both (contract section 10:
   * "report 'this board has no board pack'").
   */
  async start(profile: ConnectionProfile): Promise<RuntimeStatus> {
    this.stop();
    this.profileId = profile.id;
    // Which board this is (the physical board and the connection are two layers — contract `spec/02` section 10.2)
    this.deviceKey = deviceKeyOf(profile);
    this.detailCode = undefined;

    // 1) Build the connection
    const log = this.opts.createLog(`tags-${profile.id}`, profile.transport);
    const connection = await this.opts.createConnection(profile, log);
    try {
      await connection.open();
    } catch (err) {
      this.state = 'error';
      this.detail = err instanceof Error ? err.message : String(err);
      // The error code comes with it: telling "is the serial line held by another program" relies on the closed codes, not on the message
      this.detailCode = err instanceof AppError ? err.code : undefined;
      return this.status;
    }
    this.connection = connection;

    // 2) Bind the board pack (the connection names one first, otherwise it is detected by the model)
    const binding = await resolvePack({
      connection,
      boardPackId: profile.board_pack ?? null,
      packsDir: this.opts.packsDir,
      userPacksDir: this.opts.userPacksDir,
    });
    if (binding.pack === null) {
      this.state = 'no-pack';
      this.detail = binding.reason;
      await this.closeConnection();
      return this.status;
    }

    this.pack = binding.pack;

    // 3) Validate (a pack that does not pass its own validator is not sampled)
    const errs = errorsOf(validatePack(binding.pack));
    if (errs.length > 0) {
      this.state = 'error';
      this.detail = `board pack "${binding.pack.id}" did not pass validation: ${errs
        .map((e) => `rule ${e.rule} · ${e.path}`)
        .join('; ')}`;
      await this.closeConnection();
      return this.status;
    }

    // 4) Start the scheduler (every round trip goes through the queue, contract section 1.2.1)
    const sampler = new TagSampler(binding.pack, connection, this.store);
    this.sampler = sampler;
    this.scheduler = new PollScheduler(binding.pack, sampler, this.queue);
    this.scheduler.start();

    // The readings leave only through the TagStore (ADR-D22)
    this.store.subscribe((reading) => {
      for (const listener of this.listeners) listener(reading);
    });

    this.state = 'running';
    this.detail = undefined;
    return this.status;
  }

  /**
   * Run one exclusive transaction on this connection.
   *
   * ── Who uses this ──
   *
   * The action executor of M6: one action is "execute the command + read
   * back", and those two steps have to be one indivisible exclusive
   * transaction (ADR-D23 / SPEC-D22): if the read back is jumped into by a
   * sampling, what it reads may be the output of another command — "the
   * read back does not match" becomes a false negative and the cockpit shows
   * a wrong real state.
   *
   * @param fn gets the connection and does the work (both the execution and
   *   the read back are inside)
   * @throws when no connection is open (`CONN_CLOSED`)
   */
  async runTransaction<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
    const connection = this.connection;
    if (connection === undefined) {
      throw new AppError('CONN_CLOSED', 'the runtime is not connected to any connection yet');
    }
    return this.queue.run('action-verify', () => fn(connection));
  }

  /** The id of the current board pack (the credentials are bound to it) */
  /**
   * The list of actions (for the permission area of the settings page —
   * ADR-D47).
   *
   * → Only the id and the label — the arguments and the command are not
   *   given (the same rule as in `pack-view`).
   */
  get actionSummaries(): { id: string; label?: string; danger: string }[] {
    return (this.pack?.actions ?? []).map((action) => ({
      id: action.id,
      ...(action.label === undefined ? {} : { label: action.label }),
      danger: action.danger,
    }));
  }

  get packId(): string | undefined {
    return this.pack?.id;
  }

  /**
   * The `device_key` of the board that is bound right now (contract
   * `spec/02` section 10.2).
   *
   * → `undefined` when no connection is running (do not guess).
   */
  get currentDeviceKey(): string | undefined {
    return this.deviceKey;
  }

  /**
   * The redacted read-only projection of the current board pack (the
   * read-side tools of MCP need it).
   *
   * → The raw pack is not given — the raw arguments carry a `command` and
   *   host paths (the allow list of `tags/pack-view.ts` blocks them —
   *   contract section 1.3).
   * → `null` when there is no pack (do not guess).
   */
  get packView(): PackView | null {
    return packView(this.pack);
  }

  /**
   * The actions declared in the board pack (the full definition — the
   * parameters, the guard, the command, the readback).
   *
   * → Not `packView.actions` (that one has only the ids — it is the list
   *   for the agent).
   * → The executor needs the full definition (it needs the command, the
   *   guard, the readback).
   */
  get actionDefs(): ActionDef[] {
    return this.pack?.actions ?? [];
  }

  /**
   * The sample buffer (the most recent samples) — it backs `sample_tag(name,
   * n)` and `describe_tag.history`.
   *
   * → A directed sampling first (contract v5 section 2.1: without it the
   *   agent gets a frozen old sample).
   */
  async sampleTagHistory(tag: string, n: number): Promise<TagSample[]> {
    await this.sampleTag(tag);
    return this.store.history(tag, n);
  }

  /**
   * The sample buffer (no sampling — synchronous).
   *
   * → `describe_tag.history` needs it (describing a quantity does not have
   *   to bother the board).
   * → `sample_tag` wants the version taken after a sampling
   *   (`sampleTagHistory`).
   */
  sampleHistory(tag: string, n: number): TagSample[] {
    return this.store.history(tag, n);
  }

  /**
   * Does this connection have an exit code (a serial line does not, fact
   * S5).
   *
   * The readback forms 3 / 4 look at the exit code → without one they have
   * to be rejected (end of contract section 4.4).
   */
  get hasExitCode(): boolean {
    return this.connection?.capabilities().exitCode === true;
  }

  /**
   * The actions declared in the board pack (by id) — the executor needs them
   * (`spec/02` section 4).
   *
   * The definition of an action lives only in the board pack (a card cannot
   * declare a command of its own, that is a red line of contract section
   * 5), so the executor has to get it from here.
   */
  actionDef(actionId: string): ActionDef | undefined {
    return this.pack?.actions.find((action) => action.id === actionId);
  }

  /**
   * Read one tag in a directed way (fresh — not the value of the next
   * period).
   *
   * The readback form 1 wants exactly this (contract section 4.4): the
   * standard of "the board says it happened" is a reading of the moment; if
   * it waits for the next sampling period, the readback may see the value
   * from before the action.
   */
  async sampleTag(tag: string): Promise<TagReading | undefined> {
    const pack = this.pack;
    if (pack === undefined) return undefined;
    const group = pack.poll_groups.find((g) =>
      [...g.readers].some((readerId) => {
        const reader = [...pack.readers, ...pack.custom].find((r) => r.id === readerId);
        return reader?.provides.some((p) => p.tag === tag || matchTagPattern(p.tag, tag)) === true;
      }),
    );
    if (group === undefined) return undefined;
    await this.sampler?.sampleGroup(group.id);
    return this.store.get(tag);
  }

  /** Stop: stop the scheduler, close the connection */
  stop(): void {
    this.scheduler?.stop();
    this.scheduler = undefined;
    void this.closeConnection();
    this.state = 'idle';
    this.detail = undefined;
    this.detailCode = undefined;
  }

  /** The snapshot of the current readings (a late subscriber sees the current numbers through it) */
  readings(): TagReading[] {
    return this.store.all();
  }

  /** Listen for changes of the readings */
  subscribe(cb: (reading: TagReading) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const at = this.listeners.indexOf(cb);
      if (at >= 0) this.listeners.splice(at, 1);
    };
  }

  private async closeConnection(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    if (connection === undefined) return;
    await connection.close().catch(() => undefined);
  }
}

/* ══════════════════════════════════════════════════════════════════
   What to do when it does not come up (plan 4, task 2)
   ── three real bugs, measured on 2026-11-13 ──
   ══════════════════════════════════════════════════════════════════ */

/** One candidate on which the runtime can be tried */
export interface RuntimeCandidate {
  profileId: string;
  profile: ConnectionProfile;
}

/**
 * The backoff steps (milliseconds).
 *
 * Why there is a backoff: the board may not be plugged in yet, adb may not
 * be authorised yet — both get better by themselves after a while, so the
 * attempt has to be repeated later. The steps are capped at 30 s: denser
 * than that is noisy, sparser than that is slow.
 */
export const RETRY_BACKOFF_MS: readonly number[] = [2000, 5000, 10000, 30000];

/**
 * Pick the candidates: only the profiles that have a board pack bound.
 *
 * The fix for P2: the old test was `board_pack !== undefined` — and the
 * `board_pack` of `local.json` and `ubuntu-ssh.json` is `null`,
 * `null !== undefined` is true → they were taken as candidates → the
 * runtime went to connect to the local machine and to the SSH of
 * 192.168.100.10 and read their `/proc/device-tree/model` (which cannot
 * possibly be recognised).
 *
 * The cost is not simply "two connections opened for nothing": a serial
 * line is exclusive, and a failed serial attempt may keep the port and
 * squeeze out the adb that does work.
 *
 * The criterion is `!= null` (it removes `null` and `undefined` at the
 * same time).
 */
export function pickCandidates(profiles: ConnectionProfile[]): RuntimeCandidate[] {
  return profiles
    .filter((p) => p.board_pack != null)
    .map((p) => ({ profileId: p.id, profile: p }));
}

/**
 * Decide whether the port is held by another program.
 *
 * The error code comes first (`PORT_BUSY` is an item of the closed
 * enumeration, `hal/serial.ts` already uses it), and the message match is
 * the fallback — a message match is a fallback, not the main criterion (a
 * criterion that breaks when one word is changed is not a criterion).
 */
export function isPortBusy(detail: string, code?: string): boolean {
  if (code === 'PORT_BUSY') return true;
  return /is busy|EBUSY|EACCES/i.test(detail);
}

/**
 * The part of the runtime that a substitute can stand in for.
 *
 * Why a structural type and not `TagRuntime`: `TagRuntime` has private
 * fields, a substitute cannot fake it (TypeScript would refuse) → the tests
 * would have to force a cast with `as any`, and then they would not be
 * testing the real interface. This is narrowed to "only `start` is needed",
 * which the real `TagRuntime` satisfies naturally and a substitute can
 * enter as well.
 */
export interface TagRuntimeLike {
  start(profile: ConnectionProfile): Promise<RuntimeStatus>;
}

/**
 * Start the runtime: try the candidates one by one, back off and retry
 * after a failure.
 *
 * The fix for P1: the old code tried each candidate once and gave up → a
 * board that is plugged in later left the panel empty until the
 * application was restarted.
 *
 * The serial policy (the user ruled on 2026-11-14): when a candidate fails
 * because the port is busy, skip it and try the next one, and do not try it
 * again in the later rounds — what holds the port is another program, so
 * waiting for it to exit is the only thing that helps, and the panel must
 * not be held hostage by one busy serial line.
 *
 * @param opts.sleep the injected waiting function (the tests use a fake
 *   sleep and do not really wait)
 */
export async function startWithRetry(
  runtime: TagRuntimeLike,
  candidates: RuntimeCandidate[],
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<RuntimeStatus> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  if (candidates.length === 0) {
    return { state: 'error', detail: 'no connection carries a board pack (the candidate list is empty)' };
  }

  /** The candidates whose port is busy: another program holds the port, retrying them is pointless */
  const skipped = new Set<string>();
  let last: RuntimeStatus = { state: 'error', detail: 'no candidate was tried' };

  // The rounds = 1 (immediately) + one round after each backoff step
  for (let round = 0; round <= RETRY_BACKOFF_MS.length; round += 1) {
    for (const candidate of candidates) {
      if (skipped.has(candidate.profileId)) continue;
      const status = await runtime.start(candidate.profile);
      if (status.state === 'running') return status;
      last = status;
      if (isPortBusy(status.detail ?? '', status.detailCode)) {
        skipped.add(candidate.profileId);
      }
    }
    if (round < RETRY_BACKOFF_MS.length) {
      await sleep(RETRY_BACKOFF_MS[round]);
    }
  }

  return last;
}

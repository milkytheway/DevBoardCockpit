import { makeError } from '../../shared/errors';
import { RoundTripQueue } from '../hal/round-trip-queue';
import type { Connection } from '../hal/connection';
import type { ConnectionProfile } from '../profiles/schema';

/**
 * The target registry — role → connection.
 *
 * ── Which gap it fills ──
 *
 * The executor of M6 can only execute on the connection of the runtime
 * (the board) — the wiring gives it `runtime.runTransaction`
 * (`src/main/index.ts`). And "run one scp on the guest" (a direct
 * transfer, ADR-D31 R7) needs another connection.
 * → A17 of plan 5 wrote "the executor has to be able to execute on a
 *   given connection", and the implementation never had it ✗.
 * → This layer fills that gap: a connection by profile id, and the
 *   executor can name its target ✓.
 *
 * ── The three rules ──
 *
 * 1. One line per target: one connection per profile plus its own
 *    queue (a serial line is one wire — two targets each go their own
 *    way ✓).
 * 2. A profile that does not exist → an error: never quietly connect
 *    to another target ✗.
 * 3. The same target reuses the same connection: opening another ssh
 *    takes several seconds ✗.
 */
export interface TargetRegistryOptions {
  /** Find a profile by id (the ones the host loaded; not finding it means there is no such target) */
  profileFor: (profileId: string) => ConnectionProfile | undefined;
  /** Build the connection (the host provides it: it knows the adb path, the fake device and the like) */
  createConnection: (profile: ConnectionProfile) => Connection;
  /** The default deadline of a transaction (milliseconds) — a long step has to pass a bigger one itself */
  deadlineMs?: number;
}

const DEFAULT_DEADLINE_MS = 3_000;

export class TargetRegistry {
  /** The connections that are open (by profile id) */
  private readonly connections = new Map<string, Connection>();
  /** The queue of each target (one queue per line) */
  private readonly queues = new Map<string, RoundTripQueue>();
  /** The connections that are being opened (to avoid opening two of the same line concurrently) */
  private readonly opening = new Map<string, Promise<Connection>>();

  constructor(private readonly opts: TargetRegistryOptions) {}

  /** How many targets are open right now (for the diagnostics) */
  get openCount(): number {
    return this.connections.size;
  }

  /**
   * Get the connection of a target (opened the first time, reused after
   * that).
   *
   * @throws when the target does not exist → `CONN_OPEN_FAILED` (no
   *   silent fallback)
   */
  async connectionFor(profileId: string): Promise<Connection> {
    const existing = this.connections.get(profileId);
    if (existing !== undefined) return existing;

    const inFlight = this.opening.get(profileId);
    if (inFlight !== undefined) return inFlight;

    const opening = this.open(profileId);
    this.opening.set(profileId, opening);
    try {
      const connection = await opening;
      this.connections.set(profileId, connection);
      return connection;
    } finally {
      this.opening.delete(profileId);
    }
  }

  /**
   * Run one exclusive transaction on a target.
   *
   * ── Why "exclusive" ──
   *
   * Two round trips on the same target must not run concurrently (a
   * serial line is one wire; an ssh session has one channel too).
   * → It goes through its own queue (at the `action-verify` level: an
   *   action and its readback are indivisible, SPEC-D22) ✓.
   *
   * ── The deadline ──
   *
   * 3 seconds by default (the same default as at the connection level,
   * ADR-D23); a long step has to pass a bigger one itself (compiling
   * takes minutes → the transport was measured to fluctuate by a factor of
   * 20, A14).
   * The deadline only covers how long it waited in the queue, not how
   * long it runs ✓.
   */
  async runOn<T>(
    profileId: string,
    fn: (connection: Connection) => Promise<T>,
    opts: { deadlineMs?: number } = {},
  ): Promise<T> {
    const connection = await this.connectionFor(profileId);
    const queue = this.queueFor(profileId);
    return queue.run('action-verify', () => fn(connection), {
      deadlineMs: opts.deadlineMs ?? this.opts.deadlineMs ?? DEFAULT_DEADLINE_MS,
    });
  }

  /** Clean up: close every connection (called when a workflow finishes) */
  async closeAll(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    this.queues.clear();
    for (const connection of connections) {
      try {
        await connection.close();
      } catch {
        // A target that does not close is not fatal: one target that stays open must not throw away the account of the whole run
      }
    }
  }

  private queueFor(profileId: string): RoundTripQueue {
    const existing = this.queues.get(profileId);
    if (existing !== undefined) return existing;
    const created = new RoundTripQueue();
    this.queues.set(profileId, created);
    return created;
  }

  private async open(profileId: string): Promise<Connection> {
    const profile = this.opts.profileFor(profileId);
    if (profile === undefined) {
      throw makeError('CONN_OPEN_FAILED', `no such connection profile: ${profileId}`, {
        detail: { profileId },
      });
    }
    // A role must not be bound to `local` (ADR-D31 R2 ✓):
    // `local` is the host's own shell (cmd.exe on Windows) — a workflow
    // running a command on it is running a command on the host, and the
    // host is the machine that has root ✓✗.

    if (profile.transport === 'local') {
      throw makeError('CONN_OPEN_FAILED', `a role must not be bound to the local transport (${profileId}): it is the host's own shell`, {
        detail: { profileId, transport: profile.transport },
      });
    }
    const connection = this.opts.createConnection(profile);
    await connection.open();
    return connection;
  }
}

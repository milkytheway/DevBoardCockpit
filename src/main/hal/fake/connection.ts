import type { Connection, ConnectionCapabilities, ExecResult } from '../connection';
import type { FileEntry } from '../../../shared/ipc-contract';
import type { SessionLog } from '../../logging/session-log';
import { makeError } from '../../../shared/errors';
import { capabilitiesFor } from '../capabilities';
import { Session } from '../session';
import { FAKE_DEVICE_MARKER, FakeDevice } from './device';
import { fakeExecOutput } from './exec';
import { fakeFileCommand } from './file-ops';
import { fakeFilesystem, VirtualFs } from './fs';
import { fakeProfile } from './profile';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

/**
 * ⚠️ **The fake device** — a fake connection that runs on the HAL boundary.
 *
 * ── Why it sits here and does not feed the `TagStore` directly ──
 *
 * Because **the five states are the contract**: `pending` (the first read),
 * `stale` (the read failed but there was a good value before),
 * `unavailable` (the resource is not there), `error` (it is there but broken).
 * If the fake device made up these states itself, that would be **a second
 * copy of the contract** — and it would eventually drift from the real
 * implementation, and what drifts is exactly the most important part.
 *
 * → The fake device only emits **raw text** (jiffies / kB / @Hz /
 * millidegrees), and **the percentages and the five states are judged by the
 * real kinds and the real store** ✓.
 *
 * Two things come for free:
 * - the **difference semantics** of `cpu.usage` hold by themselves (a counter
 *   is integrated, so it grows monotonically ✓)
 * - `unavailable` shows up naturally as well (the debugfs path of the NPU
 *   **simply does not exist** ✓, just like on a real board)
 */

/**
 * The fake connection's knobs.
 *
 * **The fault injection is optional** (`0` = no injection): the defaults are
 * there for debugging, a test has to hit a given round **deterministically**,
 * so the rhythm is handed over.
 */
export interface FakeConnectionOptions {
  /** The clock (milliseconds). */
  now: () => number;
  /** The session log (the fake shell writes there). */
  log: SessionLog;
  /** The profile (its capabilities decide pty/pipe — **not** a local copy). */
  profile?: ConnectionProfileLike;
  /** Every Nth **fast-group** round trips time out (0 = never). Default 20. */
  timeoutEvery?: number;
  /** Every Nth **meminfo** round comes back broken (0 = never). Default 5. */
  breakMeminfoEvery?: number;
  /**
   * The **virtual disk** this connection sees.
   *
   * Default: the disk **shared by the same profile** (`fakeFilesystem(profileId)`)
   * —— one fake board, one disk: what the runtime writes, the terminal's file
   * browser sees ✓.
   *
   * Injectable: the tests want a fresh disk each time.
   */
  fs?: VirtualFs;
}

/** The profile shape we need (the real one, structurally). */
type ConnectionProfileLike = Parameters<typeof capabilitiesFor>[0];

/** The default cadence: slow enough that the gauges are mostly alive. */
const DEFAULT_TIMEOUT_EVERY = 20;
const DEFAULT_BREAK_MEMINFO_EVERY = 5;

export class FakeConnection implements Connection {
  /** The id of the connection **follows the profile** (when the fake device plays several roles every line has its own id ✓) */
  readonly id: string;
  /** The transport **follows the profile** (the capability bits have only one algorithm either ✓ — `capabilitiesFor(this.profile)`) */
  readonly transport: 'local' | 'ssh' | 'adb' | 'serial';

  private readonly device: FakeDevice;
  private readonly log: SessionLog;
  private readonly profile: ConnectionProfileLike;
  /** The fake board's **disk** (shared by every connection to the same profile). */
  private readonly fs: VirtualFs;
  /** How many **fast-group** commands have been run (the timeout counts on this). */
  private fastRounds = 0;
  /** How many **meminfo** commands have been run (the breakage counts on this). */
  private meminfoRounds = 0;
  private readonly timeoutEvery: number;
  private readonly breakMeminfoEvery: number;

  constructor(opts: FakeConnectionOptions) {
    this.device = new FakeDevice({ now: opts.now });
    this.log = opts.log;
    this.profile = opts.profile ?? fakeProfile();
    this.id = this.profile.id;
    this.transport = this.profile.transport;
    this.fs = opts.fs ?? fakeFilesystem(this.profile.id);
    this.timeoutEvery = opts.timeoutEvery ?? DEFAULT_TIMEOUT_EVERY;
    this.breakMeminfoEvery = opts.breakMeminfoEvery ?? DEFAULT_BREAK_MEMINFO_EVERY;
  }

  /**
   * The capabilities come from the **profile**, not from a local copy.
   *
   * `capabilitiesFor` is the single implementation
   * (`hal/capabilities.ts` — "no second algorithm allowed").
   * A local copy is exactly how the old "pty comes from the transport name"
   * bug happened: two sources of truth that disagree.
   */
  capabilities(): ConnectionCapabilities {
    return capabilitiesFor(this.profile);
  }

  async open(): Promise<void> {
    // Nothing to open — the board is imaginary.
  }

  async close(): Promise<void> {
    // Nothing to close.
  }

  async exec(command: string, _opts?: { timeoutMs?: number }): Promise<ExecResult> {
    // ── The file commands are recognised first ──
    //
    // **The command of an action is a single statement** (`echo 128 > /p`, `cat -- '/p'`,
    // `test -s /p`, `grep -qF 'x' /p`) — what they want is the **exit code** and the **side effect**.
    // while the fetch command of the sampler is **multi-statement** (`echo '<marker>'; cat -- '<p>'; …`)
    // → that belongs to the little shell (`fake/exec.ts`), and **not one character more**.
    //
    // When it is not recognised it returns `null` → the original path continues (**no guessing**).
    const fileResult = fakeFileCommand(command, {
      fs: this.fs,
      deviceRead: (path) => this.device.read(path),
    });
    if (fileResult !== null) return fileResult;

    // ── Failure injection ──
    //
    // The five states have to be *reachable* while you are designing the UI:
    // an interface that never shows "unavailable" is an interface whose
    // unavailable state was never designed.
    //
    // **The injection has to land on the right group**:
    // The three polling groups share one connection, so counting by "the n-th exec on this connection"
    // makes "break meminfo every 17 rounds" land almost always on a group that **does not read meminfo**
    // (so the error state is practically never seen),
    // while "time out every 7 rounds" mostly lands on the fast group → the CPU/GPU are almost always stale.
    //
    // → **Count per path in the command**: a timeout counts for the fast group (`/proc/stat`),
    // and the broken meminfo counts for the round that really reads meminfo.
    const isFast = command.includes('/proc/stat');
    const isMeminfo = command.includes('/proc/meminfo');

    if (isFast) {
      this.fastRounds += 1;
      if (this.timeoutEvery > 0 && this.fastRounds % this.timeoutEvery === 0) {
        return {
          exitCode: 124,
          stdout: '',
          stderr: '',
          durationMs: 5000,
          timedOut: true,
          hint: 'simulating one round trip timeout (fake device)',
        };
      }
    }

    let broken = false;
    if (isMeminfo) {
      this.meminfoRounds += 1;
      broken = this.breakMeminfoEvery > 0 && this.meminfoRounds % this.breakMeminfoEvery === 0;
    }

    const stdout = fakeExecOutput(this.device, command, { brokenMeminfo: broken });
    return {
      exitCode: 0,
      stdout,
      stderr: '',
      durationMs: 12,
      timedOut: false,
    };
  }

  /**
     * The fake board **has a disk now** —— pulling really writes the file.
     *
     * ── Why it cannot keep "just throwing an error" ──
     *
     * The readback of the write side (M6) has three forms that land on a file
     * (`file_equals` / `command_ok` / `verify`).
     * If the fake device had no files at all, **the criterion "action → readback
     * → the interface renders the value of the readback" could not be run on the
     * fake device** (it would depend on a real board → not automatable).
     *
     * ── Where it is still honest ──
     *
     * **Pulling a file that does not exist → an error**, not "reports success" —
     * "reporting success without transferring the file = lying" (that rule has
     * not changed; it simply has files to transfer now).
     */
  async pull(remotePath: string, localPath: string): Promise<void> {
    const content = this.fs.read(remotePath);
    if (content === null) {
      throw makeError('CONN_OPEN_FAILED', `there is no ${remotePath} on the fake device (no remote file to pull)`);
    }
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, content);
  }

  /**
     * Push: the file really lands on the fake board's disk.
     *
     * **The remote is a directory** (the uniform convention of the HAL) → the
     * basename is appended ✓.
     * **The bytes are preserved**: what is read is a Buffer (a `.ko` is binary,
     * and transcoding it destroys it).
     */
  async push(localPath: string, remotePath: string): Promise<void> {
    if (!existsSync(localPath)) {
      throw makeError('CONN_OPEN_FAILED', `there is no ${localPath} on this host (nothing to push)`);
    }
    const target = remotePath.endsWith('/')
      ? `${remotePath}${basename(localPath)}`
      : remotePath;
    this.fs.write(target, readFileSync(localPath));
  }

  async list(remotePath: string): Promise<FileEntry[]> {
    const base = remotePath.replace(/\/$/, '');
    return this.fs.list(base).map((entry) => ({
      name: entry.name,
      path: entry.path,
      isDirectory: entry.isDirectory,
      sizeBytes: entry.sizeBytes,
      modifiedAt: null,
    }));
  }

  async openSession(_opts?: { cols?: number; rows?: number }): Promise<Session> {
    return new FakeShellSession(this.log);
  }
}

/**
   * A fake shell: it knows two commands.
   *
   * Enough to design the terminal page against (a prompt, a banner, a
   * command that answers) without a board plugged in.
   *
   * ── It is the **pipe mode** (the profile declares `pty: false`) ──
   *
   * In the pipe mode **the echo and the prompt are the business of the host**
   * (`terminal/line-editor.ts`): the host sends the whole line over, echoes
   * what the user typed, and draws the prompt.
   * → So nothing is echoed here (an echo would be two lines of text),
   * and **what arrives is the whole line** (`uname` is one word, not five
   * keys).
   */
class FakeShellSession extends Session {
  readonly exitCode = null;
  private readonly sinks: ((chunk: string) => void)[] = [];
  private readonly exitCbs: ((exitCode: number | null) => void)[] = [];

  constructor(log: SessionLog) {
    super(log);
  }

  write(data: string): void {
    const line = data.replace(/\r/g, '').trim();
    if (line.includes('uname')) {
      this.emit('Linux rk3588 6.1.0 #1 SMP aarch64 GNU/Linux\r\n');
      return;
    }
    if (line.includes('help')) {
      this.emit('uname -a   - this list\r\nhelp      - this list\r\n');
      return;
    }
    if (line.includes('exit')) {
      this.emit('logout\r\n');
      // **The session has to really end**: otherwise the interface keeps a dead tab,
      // the user keeps typing into the dead channel (contract §7: the interface has to show what the board **actually** is doing).
      for (const cb of this.exitCbs) cb(0);
      return;
    }
    // **No echo**: in the pipe mode the host echoes (an echo would be two lines of text)
  }

  resize(_cols: number, _rows: number): void {
    // The fake shell has no window.
  }

  close(): void {
    // Nothing to close.
  }

  onData(cb: (chunk: string) => void): void {
    const isFirst = this.sinks.length === 0;
    this.sinks.push(cb);
    if (!isFirst) return;
    // **The banner is sent after the first listener has come**.
    //
    // At the moment of the construction there is no listener yet (the
    // `session.onData(...)` of the host is registered **after** `openSession()`) → sending it then is sending it into the void.
    //
    // The banner carries the marker string:
    // ① the terminal **says out loud that this is synthetic data** (otherwise somebody takes the fake numbers for real ones);
    // ② the marker string therefore **stays in the artefact**, so that the build self-check can find it
    //    (a constant that is exported but never used is shaken out by rollup — the check would be a sham).
    this.emit(`⚠ synthetic data (${FAKE_DEVICE_MARKER}) — this is not a real board; type help to see what it can do\r\n`);
  }

  /** The session ended by itself (the user typed `exit`). */
  onExit(cb: (exitCode: number | null) => void): void {
    this.exitCbs.push(cb);
  }

  private emit(chunk: string): void {
    for (const sink of this.sinks) sink(chunk);
  }
}

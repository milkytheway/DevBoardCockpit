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
 * ⚠️ **假设备** —— 一条假的连接，跑在 HAL 边界上。
 *
 * ── 为什么放在这里，而不是直接喂 `TagStore` ──
 *
 * 因为**五态是契约**：`pending`（首读）、`stale`（读失败但有过好值）、
 * `unavailable`（资源不在）、`error`（在但坏了）。
 * 如果假设备自己造这些状态，那就是**把契约抄了第二份**——
 * 迟早与真实现漂移，而漂移的正是最要紧的那部分。
 *
 * → 假设备只吐**原始文本**（jiffies / kB / @Hz / 毫度），
 * **百分比与五态由真正的 kind 与真正的 store 判出来** ✓。
 *
 * 顺带白送两件事：
 * - `cpu.usage` 的**做差语义**自动成立（计数器是积分出来的，单调递增 ✓）
 * - `unavailable` 也自然出现（NPU 的 debugfs 路径**就是不存在** ✓，跟真板一样）
 */

/**
 * The fake connection's knobs.
 *
 * **故障注入是可选的**（`0` = 不注入）：默认值给调试用，
 * 测试要**确定性地**命中某一轮，所以把节奏交出去。
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
  /** 连接的 id **跟着 profile 走**（假设备扮多个角色时每条线各有各的 id ✓） */
  readonly id: string;
  readonly transport = 'local' as const;

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
    // ── 文件命令先认 ──
    //
    // **动作的命令是单语句的**（`echo 128 > /p`、`cat -- '/p'`、
    // `test -s /p`、`grep -qF 'x' /p`）——它们要的是**退出码**与**副作用**。
    // 而采样器的取数命令是**多语句**的（`echo '<marker>'; cat -- '<p>'; …`）
    // → 那归小 shell（`fake/exec.ts`）管，**一个字都不能多**。
    //
    // 认不出来就返回 `null` → 往下走原来的路（**不猜**）。
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
    // **注入要落在对的组上**：
    // 三个轮询组共用一条连接，按「这条连接上的第几次 exec」计数的话，
    // 「每 17 轮坏一次 meminfo」几乎永远落在**不读 meminfo** 的组上
    // （于是 error 那一态基本看不见），
    // 而「每 7 轮超时」则多半落在快组 → CPU/GPU 几乎一直 stale。
    //
    // → **按命令里的路径分别计数**：超时算快组（`/proc/stat`），
    // meminfo 的坏算真的读 meminfo 的那一轮。
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
          hint: '模拟一次往返超时（假设备）',
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
   * ── 为什么不能继续「直接抛错」──
   *
   * 写侧（M6）的回读有三种形式落在文件上（`file_equals` / `command_ok` / `verify`）。
   * 假设备若连文件都没有，**「动作 → 回读 → 界面按回读值渲染」这条判据
   * 在假设备上根本跑不了**（只能靠真板 → 不可自动化）。
   *
   * ── 仍然诚实的地方 ──
   *
   * **拉一个不存在的文件 → 报错**，不是「报告成功」——
   * 「报告成功却不传文件 = 骗人」（这条规矩没变，只是现在它有文件可传了）。
   */
  async pull(remotePath: string, localPath: string): Promise<void> {
    const content = this.fs.read(remotePath);
    if (content === null) {
      throw makeError('CONN_OPEN_FAILED', `假设备上没有 ${remotePath}（没有可拉的远端文件）`);
    }
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, content);
  }

  /**
   * Push: the file really lands on the fake board's disk.
   *
   * **远端是目录**（HAL 的统一约定）→ 补上 basename ✓。
   * **字节保真**：读的是 Buffer（`.ko` 是二进制，转码即损坏）。
   */
  async push(localPath: string, remotePath: string): Promise<void> {
    if (!existsSync(localPath)) {
      throw makeError('CONN_OPEN_FAILED', `本机没有 ${localPath}（推不上去）`);
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
 * ── 它是 **pipe 模式**（profile 声明 `pty: false`）──
 *
 * pipe 模式下**回显与提示符是宿主的事**（`terminal/line-editor.ts`）：
 * 宿主把整行送过来、把用户打的字回显出来、把提示符画出来。
 * → 所以这里**不回显**（回了就是两行字），
 * 而且**收到的是整行**（`uname` 是一个词，不是五个键）。
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
      // **会话要真的结束**：否则界面留着一个死标签，
      // 用户继续往死通道里打字（契约 §七：界面要显示板子**实际**在做什么）。
      for (const cb of this.exitCbs) cb(0);
      return;
    }
    // **不回显**：pipe 模式由宿主回显（回了就是两行字）
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
    // **横幅在第一个监听者来了之后再发**。
    //
    // 构造那一刻还没有监听者（宿主的 `session.onData(...)` 在
    // `openSession()` **之后**才注册）→ 那时候发等于没发。
    //
    // 横幅里带着标记串：
    // ① 终端上**明说这是合成数据**（不然有人会把假数当真数看）；
    // ② 标记串因此**留在产物里**，构建自检才验得到它
    //    （导出但没人用的常量会被 rollup 摇掉——检查就成了摆设）。
    this.emit(`⚠ 合成数据（${FAKE_DEVICE_MARKER}）—— 不是真板子；输入 help 看能做什么\r\n`);
  }

  /** The session ended by itself (the user typed `exit`). */
  onExit(cb: (exitCode: number | null) => void): void {
    this.exitCbs.push(cb);
  }

  private emit(chunk: string): void {
    for (const sink of this.sinks) sink(chunk);
  }
}

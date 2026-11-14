import type { Connection, ConnectionCapabilities, ExecResult } from '../connection';
import type { FileEntry } from '../../../shared/ipc-contract';
import type { SessionLog } from '../../logging/session-log';
import { Session } from '../session';
import { FAKE_DEVICE_MARKER, FakeDevice } from './device';
import { fakeExecOutput } from './exec';
import { FAKE_PROFILE_ID } from './profile';

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
  /** Every Nth round trips time out (0 = never). Default 7. */
  timeoutEvery?: number;
  /** Every Nth round the memory file comes back broken (0 = never). Default 17. */
  breakMeminfoEvery?: number;
}

export class FakeConnection implements Connection {
  readonly id = FAKE_PROFILE_ID;
  readonly transport = 'local' as const;

  private readonly device: FakeDevice;
  private readonly log: SessionLog;
  /** How many commands have been run (the failure injection counts on this). */
  private rounds = 0;
  private readonly timeoutEvery: number;
  private readonly breakMeminfoEvery: number;

  constructor(opts: FakeConnectionOptions) {
    this.device = new FakeDevice({ now: opts.now });
    this.log = opts.log;
    this.timeoutEvery = opts.timeoutEvery ?? 7;
    this.breakMeminfoEvery = opts.breakMeminfoEvery ?? 17;
  }

  capabilities(): ConnectionCapabilities {
    return { exec: true, pty: true, files: true, exitCode: true };
  }

  async open(): Promise<void> {
    // Nothing to open — the board is imaginary.
  }

  async close(): Promise<void> {
    // Nothing to close.
  }

  async exec(command: string, _opts?: { timeoutMs?: number }): Promise<ExecResult> {
    this.rounds += 1;
    // ── Failure injection ──
    //
    // The five states have to be *reachable* while you are designing the UI:
    // an interface that never shows "unavailable" is an interface whose
    // unavailable state was never designed.
    //
    // - every 7th round the round-trip **times out** → `stale` (the old value
    //   is kept) ✓
    // - every 17th round the memory file comes back **broken** → `error`
    //   (parse_error) ✓
    if (this.timeoutEvery > 0 && this.rounds % this.timeoutEvery === 0) {
      return {
        exitCode: 124,
        stdout: '',
        stderr: '',
        durationMs: 5000,
        timedOut: true,
        hint: '模拟一次往返超时（假设备）',
      };
    }
    const broken = this.breakMeminfoEvery > 0 && this.rounds % this.breakMeminfoEvery === 0;
    const stdout = fakeExecOutput(this.device, command, { brokenMeminfo: broken });
    return {
      exitCode: 0,
      stdout,
      stderr: '',
      durationMs: 12,
      timedOut: false,
    };
  }

  async pull(_remotePath: string, _localPath: string): Promise<void> {
    // The fake board has no files worth pulling.
  }

  async push(_localPath: string, _remotePath: string): Promise<void> {
    // Nor worth pushing.
  }

  async list(remotePath: string): Promise<FileEntry[]> {
    const base = remotePath.replace(/\/$/, '');
    return [
      {
        name: 'README.txt',
        path: `${base}/README.txt`,
        isDirectory: false,
        sizeBytes: 42,
        modifiedAt: null,
      },
      {
        name: 'etc',
        path: `${base}/etc`,
        isDirectory: true,
        sizeBytes: null,
        modifiedAt: null,
      },
    ];
  }

  async openSession(_opts?: { cols?: number; rows?: number }): Promise<Session> {
    return new FakeShellSession(this.log);
  }
}

/**
 * A fake shell: it echoes what you type and knows two commands.
 *
 * Enough to design the terminal page against (a prompt, a banner, a
 * command that answers) without a board plugged in.
 */
class FakeShellSession extends Session {
  readonly exitCode = null;
  private readonly sinks: ((chunk: string) => void)[] = [];

  constructor(log: SessionLog) {
    super(log);
    // **横幅里带着标记串**——
    // ① 终端上**明说这是合成数据**（不然有人会把假数当真数看）；
    // ② 标记串因此**留在产物里**，构建自检才验得到它
    //    （导出但没人用的常量会被 rollup 摇掉——检查就成了摆设）。
    this.emit(`⚠ 合成数据（${FAKE_DEVICE_MARKER}）—— 不是真板子；输入 help 看能做什么\r\n`);
  }

  write(data: string): void {
    const line = data.replace(/\r/g, '');
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
      return;
    }
    // **Echo** — a shell echoes what you type.
    this.emit(line);
  }

  resize(_cols: number, _rows: number): void {
    // The fake shell has no window.
  }

  close(): void {
    // Nothing to close.
  }

  onData(cb: (chunk: string) => void): void {
    this.sinks.push(cb);
  }

  private emit(chunk: string): void {
    for (const sink of this.sinks) sink(chunk);
  }
}

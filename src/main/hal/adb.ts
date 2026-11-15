import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { makeError } from '../../shared/errors';
import type { FileEntry } from '../../shared/ipc-contract';
import type { SessionLog } from '../logging/session-log';
import type { ConnectionProfile } from '../profiles/schema';
import { runProcess } from '../util/spawn';
import { quotePath } from '../util/shell-quote';
import { parseLsLines } from '../util/ls-output';
import { Session } from './session';
import { terminalEnvScript } from './session-env';
import type { ConnectionCapabilities, Connection, ExecOptions, ExecResult } from './connection';
import { capabilitiesFor, transportDefaults } from './capabilities';

/**
 * ADB 传输。
 *
 * 关键事实：
 *
 * - **事实 A1**：**不用 PTY**。`adb shell -t -t` 在 Windows 上会把回复攒到
 *   下一条命令才吐，表现为「晚一条」。所以 adb 走 pipe 模式。
 * - **事实 A7**：`adb devices` 里可能有 `offline` / `unauthorized`，
 *   **只认 `device`**。
 * - **事实 A8**：输出按 UTF-8 解码，坏字节不废掉整条命令（由 `runProcess` 负责）。
 * - **事实 A2/A3**：会话启动时 `export TERM=xterm-256color` 并用 shell 函数
 *   （见 `session-env.ts`）。
 *
 * adb 路径来自 `profiles/settings.json` 的 `hostTools.adb`——
 * 机器专属路径只进配置，不进代码（事实清单 §2）。
 */

export function adbCapabilities(): ConnectionCapabilities {
  return transportDefaults('adb');
}

/**
 * profile 里钉的序列号。
 *
 * 没钉（缺省 / 空串 / 不是字符串）就是 undefined——
 * 「钉了哪块板子」和「随便连一块」是两种连法，语义不能混。
 */
function profileSerial(profile: ConnectionProfile): string | undefined {
  const serial = profile.options['serial'];
  return typeof serial === 'string' && serial.length > 0 ? serial : undefined;
}

/** 构造 adb 的参数数组。序列号存在时前置 `-s <serial>`。 */
export function adbArgs(profile: ConnectionProfile, extra: string[]): string[] {
  const serial = profileSerial(profile);
  if (serial !== undefined) {
    return ['-s', serial, ...extra];
  }
  return [...extra];
}

/** `adb devices` 里的一行设备记录 */
interface DeviceRow {
  /** 序列号（第一列） */
  serial: string;
  /** 状态的第一个词：device / offline / unauthorized / no … */
  state: string;
  /** 状态原文：`no permissions (user in plugdev group)` 这类要整段留着 */
  stateText: string;
}

/**
 * 解析 `adb devices` 的输出。
 *
 * 滤掉两类**不是设备行**的行：
 * - `List of devices attached` 表头；
 * - `* daemon not running; starting now at tcp:5037` 之类的 **daemon 噪声**——
 *   它不是设备，混进 states 会把错误消息变成噪音（运维黑洞的反面）。
 */
function parseDeviceRows(stdout: string): DeviceRow[] {
  const rows: DeviceRow[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('List of devices')) continue;
    if (line.startsWith('*')) continue;
    const parts = line.split(/\s+/);
    const serial = parts[0] ?? '';
    if (serial.length === 0) continue;
    const stateText = parts.slice(1).join(' ').trim();
    rows.push({ serial, state: parts[1] ?? '', stateText });
  }
  return rows;
}

export interface AdbConnectionOptions {
  /** adb 可执行文件路径。默认 'adb'（从 PATH 找） */
  adbPath?: string;
  /** 跑 adb 的入口，测试用假实现 */
  runner?: typeof runProcess;
  /**
   * 起子进程的入口，测试用假实现。
   *
   * **为什么需要它**：`child.stdin` 的 `'error'` 有没有人接，
   * 只有真的起一个会立刻死掉的子进程才测得到——
   * 而「板子掉了线」正是那条路。
   */
  spawn?: typeof spawn;
}

export class AdbConnection implements Connection {
  readonly id: string;
  readonly transport = 'adb' as const;

  private readonly adbPath: string;
  private readonly runner: typeof runProcess;
  private readonly spawnFn: typeof spawn;
  private opened = false;

  constructor(
    private readonly profile: ConnectionProfile,
    private readonly log: SessionLog,
    opts: AdbConnectionOptions = {},
  ) {
    this.id = profile.id;
    this.adbPath = opts.adbPath ?? 'adb';
    this.runner = opts.runner ?? runProcess;
    this.spawnFn = opts.spawn ?? spawn;
  }

  capabilities(): ConnectionCapabilities {
    // **profile 感知**——不是传输常量（见 `capabilities.ts` 的说明）。
    return capabilitiesFor(this.profile);
  }

  /**
   * 打开前先确认板子在 `device` 状态。
   *
   * 笼统的「连接失败」是运维黑洞——用户看不出是**没插线**、
   * **没授权**还是**板子离线**。所以错误消息里带上原始状态串。
   *
   * **profile 钉了 serial 时只认那一块板**（事实 A7）：
   * `adb devices` 列的是**全部**设备（`-s` 也不筛选它），
   * 所以「有没有任意一块是 device」这种判据会放过一块**离线**的板子——
   * 连接开成了，之后每条命令都在 `adb -s <离线板>` 上失败，
   * **失败点离原因十万八千里**。这里按 serial 精确匹配。
   */
  async open(): Promise<void> {
    const result = await this.runner(this.adbPath, adbArgs(this.profile, ['devices']));
    const out = result.stdout;

    const rows = parseDeviceRows(out);
    const serial = profileSerial(this.profile);

    if (serial !== undefined) {
      // 钉了板子：只认这一行
      const row = rows.find((r) => r.serial === serial);
      if (!row) {
        const present = rows.map((r) => r.serial);
        const detail = present.length > 0 ? present.join(', ') : '（没有设备）';
        throw makeError(
          'CONN_OPEN_FAILED',
          `profile 指定的 serial 在 adb devices 里没有：${serial}（当前设备：${detail}）`,
          { detail: { serial, present, raw: out } },
        );
      }
      if (row.state !== 'device') {
        throw makeError(
          'CONN_OPEN_FAILED',
          `profile 指定的设备 ${serial} 状态是「${row.stateText}」，不是 device`,
          { detail: { serial, state: row.state, stateText: row.stateText, raw: out } },
        );
      }
    } else {
      // 没钉板子：老行为——至少有一块处于 device 状态
      const connected = rows.filter((r) => r.state === 'device');
      if (connected.length === 0) {
        const states = rows.map((r) => r.stateText);
        const detail = states.length > 0 ? states.join(', ') : '（没有设备）';
        throw makeError('CONN_OPEN_FAILED', `adb 没有处于 device 状态的设备：${detail}`, {
          detail: { states, raw: out },
        });
      }
    }

    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    if (!this.opened) {
      throw makeError('CONN_CLOSED', 'ADB 连接未打开', { detail: { id: this.id } });
    }
    return this.runner(this.adbPath, adbArgs(this.profile, ['shell', command]), {
      timeoutMs: opts?.timeoutMs,
      ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
    });
  }

  /**
   * 下载：走 `adb pull`。
   *
   * **不是**远端的 `pull` 命令——板子上没有那个命令。
   */
  async pull(remotePath: string, localPath: string): Promise<void> {
    const result = await this.runner(this.adbPath, adbArgs(this.profile, ['pull', remotePath, localPath]));
    if (result.exitCode !== 0) {
      throw makeError('FILE_TRANSFER_FAILED', `下载失败：${remotePath}`, {
        detail: { remotePath, localPath, stderr: result.stderr },
      });
    }
  }

  /** 上传：走 `adb push` */
  async push(localPath: string, remotePath: string): Promise<void> {
    const result = await this.runner(this.adbPath, adbArgs(this.profile, ['push', localPath, remotePath]));
    if (result.exitCode !== 0) {
      throw makeError('FILE_TRANSFER_FAILED', `上传失败：${localPath}`, {
        detail: { localPath, remotePath, stderr: result.stderr },
      });
    }
  }

  /**
   * 列远端目录：走 `adb shell ls -la <path>`（计划 Task 9 Step 3）。
   *
   * **列目录是连接层的能力**，跟 `pull`/`push` 一个层级——
   * 互传服务不该知道「adb 的远端命令长什么样」，
   * 否则每加一种传输就要改一次服务层。
   *
   * 目录的 `sizeBytes` 是 `null`（事实 G2）：**读不到的东西不是 0**。
   * `ls -la` 给目录的是 inode 块数（4096），那不是目录的大小，
   * 当成字节数报给用户就是假数据。
   */
  async list(remotePath: string): Promise<FileEntry[]> {
    const result = await this.exec(`ls -la ${quotePath(remotePath)}`);
    if (result.exitCode !== 0) {
      throw makeError('FILE_TRANSFER_FAILED', `列目录失败：${remotePath}`, {
        detail: { remotePath, stderr: result.stderr },
      });
    }
    // 末尾的 `/` 去掉再拼名字：'/root/' + 'a.txt' 不该变成 '/root//a.txt'
    const base = remotePath.replace(/\/+$/, '');
    return parseLsLines(result.stdout).map((e) => ({
      name: e.name,
      path: `${base}/${e.name}`,
      isDirectory: e.type === 'd',
      sizeBytes: e.type === 'd' ? null : e.size,
      modifiedAt: e.modifiedAt,
    }));
  }

  async openSession(_opts?: { cols?: number; rows?: number }): Promise<Session> {
    if (!this.opened) {
      throw makeError('CONN_CLOSED', 'ADB 连接未打开', { detail: { id: this.id } });
    }
    return new AdbSession(this, this.log);
  }

  /**
   * 开一条常驻的 `adb shell`。
   *
   * **不用 PTY**（事实 A1：`adb shell -t -t` 在 Windows 上会晚一条）。
   */
  spawnShell(): ChildProcessWithoutNullStreams {
    const args = adbArgs(this.profile, ['shell']);
    const child = this.spawnFn(this.adbPath, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    child.on('error', (err) => {
      console.error(`[adb shell] ${err.message}`);
    });
    // **stdin 也必须接 error**。
    // 往已经关掉的管道写会拿到 EPIPE/ECONNRESET，
    // 而流的 'error' 事件**没有监听器就会变成未捕获异常**——
    // 不是终端窗口挂掉，是**整个 Electron 主进程挂掉**。
    //
    // 触发路径是现实的：`adb devices` 校验通过之后、板子掉线或 serial 不匹配，
    // 构造器里那句写会话环境脚本就打在一条即将死的管道上。
    // （串口那条线有 `port.on('error')`、SSH 那条线有 `client.on('error')`，
    //   唯独 ADB 的 stdin 是裸的。）
    child.stdin.on('error', (err: Error) => {
      console.error(`[adb shell stdin] ${err.message}`);
    });
    return child;
  }
}

/**
 * ADB 的交互式会话。
 *
 * **一条常驻的 `adb shell` 子进程**，不是每次按键 spawn 一次：
 * 每敲一个键 spawn 一次 adb，板子的 CPU 会被拖垮（事实 A5：一次往返 ≈30ms），
 * 而且板子的任何输出都收不到。
 *
 * adb 是 pipe 模式：板子**不回显**、不出 ANSI，
 * 所以提示符与回显都由宿主负责（legacy 行为，事实 A1 的推论）。
 *
 * 会话建立时先执行一次 `terminalEnvScript()`——
 * 否则 `TERM` 还是 `dumb`（事实 A2，coreutils 拒绝着色），
 * `ls` 也不是多列有色的 shell 函数（事实 A3）。
 */
class AdbSession extends Session {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly dataCbs: ((chunk: string) => void)[] = [];
  /**
   * stdout 与 stderr **各一个** decoder。
   *
   * 共用一个的话，跨两个流被拆开的多字节字符会被拼错
   * （stdout 的前半截 + stderr 的后半截 = 一个乱码字符）。
   */
  private readonly stdoutDecoder = new StringDecoder('utf8');
  private readonly stderrDecoder = new StringDecoder('utf8');

  constructor(
    conn: AdbConnection,
    log: SessionLog,
  ) {
    super(log);
    this.child = conn.spawnShell();

    this.child.stdout.on('data', (buf: Buffer) => {
      const chunk = this.stdoutDecoder.write(buf);
      if (chunk.length === 0) return;
      for (const cb of this.dataCbs) cb(chunk);
    });
    this.child.stderr.on('data', (buf: Buffer) => {
      const chunk = this.stderrDecoder.write(buf);
      if (chunk.length === 0) return;
      for (const cb of this.dataCbs) cb(chunk);
    });

    // 会话环境：TERM 与 ls 的 shell 函数（事实 A2/A3）。
    //
    // **原样写，不要再补 `\r\n`。**
    // 脚本本身已经以 `\n` 结尾；再补一个 `\r`，那个落单的 CR 会被
    // 远端的 shell 当成**一条命令**执行——
    // 真机实测（2026-11-13，板子的 shell 是 bash）：
    //
    // ```
    // root@ATK-DLRK3588/bin/bash: line 3: $'\r': command not found
    // ```
    //
    // 串口那条线要 CR（getty 期待 CR，事实 S4），但 ADB 是 pipe 模式：
    // 远端读的是**行**，行尾就是 LF。
    this.child.stdin.write(terminalEnvScript());
  }

  readonly exitCode: number | null = null;

  write(data: string): void {
    // pipe 模式：板子不回显，宿主负责回显
    this.child.stdin.write(data);
    this.record(data);
  }

  onData(cb: (chunk: string) => void): void {
    this.dataCbs.push(cb);
  }

  /**
   * adb shell 退出了 → 上报。
   *
   * 拔线、adbd 重启、用户敲 `exit` 都会走到这里。
   * 没有它的话，界面留着标签页继续往死通道里打字。
   */
  onExit(cb: (exitCode: number | null) => void): void {
    this.child.on('exit', (code: number | null) => cb(code));
  }

  resize(_cols: number, _rows: number): void {
    // adb shell 没有窗口尺寸概念
  }

  close(): void {
    this.child.kill();
  }
}

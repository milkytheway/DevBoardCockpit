import { makeError } from '../../shared/errors';
import type { SessionLog } from '../logging/session-log';
import type { ConnectionProfile } from '../profiles/schema';
import { runProcess } from '../util/spawn';
import { Session } from './session';
import type { Capabilities, Connection, ExecResult } from './connection';

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

export function adbCapabilities(): Capabilities {
  return { exec: true, pty: false, files: true, exitCode: true };
}

/** 构造 adb 的参数数组。序列号存在时前置 `-s <serial>`。 */
export function adbArgs(profile: ConnectionProfile, extra: string[]): string[] {
  const serial = profile.options['serial'];
  if (typeof serial === 'string' && serial.length > 0) {
    return ['-s', serial, ...extra];
  }
  return [...extra];
}

export interface AdbConnectionOptions {
  /** adb 可执行文件路径。默认 'adb'（从 PATH 找） */
  adbPath?: string;
  /** 跑 adb 的入口，测试用假实现 */
  runner?: typeof runProcess;
}

export class AdbConnection implements Connection {
  readonly id: string;
  readonly transport = 'adb' as const;

  private readonly adbPath: string;
  private readonly runner: typeof runProcess;
  private opened = false;

  constructor(
    private readonly profile: ConnectionProfile,
    private readonly log: SessionLog,
    opts: AdbConnectionOptions = {},
  ) {
    this.id = profile.id;
    this.adbPath = opts.adbPath ?? 'adb';
    this.runner = opts.runner ?? runProcess;
  }

  capabilities(): Capabilities {
    return adbCapabilities();
  }

  /**
   * 打开前先确认板子在 `device` 状态。
   *
   * 笼统的「连接失败」是运维黑洞——用户看不出是**没插线**、
   * **没授权**还是**板子离线**。所以错误消息里带上原始状态串。
   */
  async open(): Promise<void> {
    const result = await this.runner(this.adbPath, adbArgs(this.profile, ['devices']));
    const out = result.stdout;

    const lines = out.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const deviceLines = lines.filter((l) => !l.startsWith('List of devices'));
    const connected = deviceLines.filter((l) => l.split(/\s+/)[1] === 'device');

    if (connected.length === 0) {
      const states = deviceLines
        .map((l) => l.split(/\s+/).slice(1).join(' ').trim())
        .filter((s) => s.length > 0);
      const detail = states.length > 0 ? states.join(', ') : '（没有设备）';
      throw makeError('CONN_OPEN_FAILED', `adb 没有处于 device 状态的设备：${detail}`, {
        detail: { states, raw: out },
      });
    }

    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  async exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    if (!this.opened) {
      throw makeError('CONN_CLOSED', 'ADB 连接未打开', { detail: { id: this.id } });
    }
    return this.runner(this.adbPath, adbArgs(this.profile, ['shell', command]), {
      timeoutMs: opts?.timeoutMs,
    });
  }

  openSession(_opts?: { cols?: number; rows?: number }): Session {
    if (!this.opened) {
      throw makeError('CONN_CLOSED', 'ADB 连接未打开', { detail: { id: this.id } });
    }
    return new AdbSession(this, this.log);
  }
}

/**
 * ADB 的交互式会话。
 *
 * adb 是 pipe 模式：板子**不回显**、不出 ANSI，
 * 所以提示符与回显都由宿主负责（legacy 行为，事实 A1 的推论）。
 */
class AdbSession extends Session {
  constructor(
    private readonly conn: AdbConnection,
    log: SessionLog,
  ) {
    super(log);
  }

  readonly exitCode: number | null = null;

  write(data: string): void {
    this.conn['exec'](data).catch(() => {
      /* 会话期的错误由日志记录，不打断输入 */
    });
    this.record(data);
  }

  resize(_cols: number, _rows: number): void {
    // adb shell 没有窗口尺寸概念
  }

  close(): void {
    /* adb shell 会话随父进程结束 */
  }
}

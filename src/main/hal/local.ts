import { makeError } from '../../shared/errors';
import type { SessionLog } from '../logging/session-log';
import type { ConnectionProfile } from '../profiles/schema';
import { runProcess } from '../util/spawn';
import { Session } from './session';
import type { Capabilities, Connection, ExecResult } from './connection';

/**
 * 本机传输。
 *
 * 宿主自己也是一个「目标」——旧工程把它当参照实现
 * （`core/local_target.py`：the host machine, as a target）。
 * 有了它，终端与文件互传的代码路径在本机就能测，不必接真板。
 */

export function localCapabilities(): Capabilities {
  return { exec: true, pty: true, files: true, exitCode: true };
}

export interface LocalConnectionOptions {
  /** 跑命令的入口，测试用 */
  runner?: typeof runProcess;
}

export class LocalConnection implements Connection {
  readonly id: string;
  readonly transport = 'local' as const;

  private readonly runner: typeof runProcess;
  private opened = false;

  constructor(
    profile: ConnectionProfile,
    private readonly log: SessionLog,
    opts: LocalConnectionOptions = {},
  ) {
    this.id = profile.id;
    this.runner = opts.runner ?? runProcess;
  }

  capabilities(): Capabilities {
    return localCapabilities();
  }

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  async exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    if (!this.opened) {
      throw makeError('CONN_CLOSED', '本机连接未打开', { detail: { id: this.id } });
    }
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const args = process.platform === 'win32' ? ['/c', command] : ['-c', command];
    return this.runner(shell, args, { timeoutMs: opts?.timeoutMs });
  }

  async openSession(_opts?: { cols?: number; rows?: number }): Promise<Session> {
    if (!this.opened) {
      throw makeError('CONN_CLOSED', '本机连接未打开', { detail: { id: this.id } });
    }
    return new LocalSession(this.log);
  }
}

/** 本机交互式会话。实现留给 node-pty（Task 8） */
class LocalSession extends Session {
  constructor(log: SessionLog) {
    super(log);
  }

  readonly exitCode: number | null = null;

  write(data: string): void {
    this.record(data);
  }

  onData(_cb: (chunk: string) => void): void {
    // 本机 pty 的输出流在 Task 8 的 node-pty 会话里接上
  }

  resize(_cols: number, _rows: number): void {
    // 本机 pty 的尺寸同步在 Task 8 的 node-pty 会话里做
  }

  close(): void {
    /* 进程随宿主退出 */
  }
}

import { copyFile } from 'node:fs/promises';
import { makeError } from '../../shared/errors';
import type { SessionLog } from '../logging/session-log';
import type { ConnectionProfile } from '../profiles/schema';
import { runProcess } from '../util/spawn';
import { Session } from './session';
import { createLocalPtySession } from '../terminal/pty';
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

  /** 下载：宿主文件系统直读 */
  async pull(remotePath: string, localPath: string): Promise<void> {
    try {
      await copyFile(remotePath, localPath);
    } catch (err) {
      throw makeError('FILE_TRANSFER_FAILED', `下载失败：${remotePath}`, {
        detail: { remotePath, localPath, cause: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  /** 上传：宿主文件系统直写 */
  async push(localPath: string, remotePath: string): Promise<void> {
    try {
      await copyFile(localPath, remotePath);
    } catch (err) {
      throw makeError('FILE_TRANSFER_FAILED', `上传失败：${localPath}`, {
        detail: { localPath, remotePath, cause: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  async openSession(opts?: { cols?: number; rows?: number }): Promise<Session> {
    if (!this.opened) {
      throw makeError('CONN_CLOSED', '本机连接未打开', { detail: { id: this.id } });
    }
    // 真 pty（node-pty）——不是那个只记日志的桩
    return createLocalPtySession(this.log, { cols: opts?.cols ?? 80, rows: opts?.rows ?? 24 });
  }
}


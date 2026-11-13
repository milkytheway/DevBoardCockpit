import { copyFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { makeError } from '../../shared/errors';
import type { SessionLog } from '../logging/session-log';
import type { ConnectionProfile } from '../profiles/schema';
import { runProcess } from '../util/spawn';
import { Session } from './session';
import { createLocalPtySession } from '../terminal/pty';
import type { Capabilities, Connection, ExecResult, FileEntry } from './connection';

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

  /**
   * 列目录：**用 fs 读，不用 `ls -la`**。
   *
   * 本机的 exec 走的是 cmd.exe（Windows）或 `/bin/sh`（其他），
   * 而 `ls -la` 是 POSIX 命令——在 cmd.exe 上它根本不存在，
   * 于是本机连接的文件树**永远是空的**。
   *
   * 计划 Task 9 写的是「adb 用 `adb shell ls -la`，ssh 用 sftp」——
   * 本机当然用自己的文件系统。
   */
  async list(remotePath: string): Promise<FileEntry[]> {
    // 根目录映射到**当前工作目录**。
    //
    // 文件浏览器默认的远端路径是 '/'（那是板子上的根），
    // 但在 Windows 上 '/' 不是一个目录——`readdir('/')` 必然失败，
    // 于是本机连接的文件树永远是空的。
    // 本机这个「目标」没有板子意义上的根，用工作目录当根最自然。
    const dir = remotePath === '/' || remotePath.length === 0 ? process.cwd() : remotePath;
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      throw makeError('FILE_TRANSFER_FAILED', `列目录失败：${remotePath}`, {
        detail: { remotePath, resolved: dir, cause: err instanceof Error ? err.message : String(err) },
      });
    }

    const out: FileEntry[] = [];
    for (const dirent of dirents) {
      // 用**解析后**的目录拼：根目录映射到了 cwd，
      // 拿未解析的 remotePath 拼出来的路径在 Windows 上是盘根，不存在——
      // 下载会直接 ENOENT。
      const path = join(dir, dirent.name);
      let isDirectory = dirent.isDirectory();
      let sizeBytes: number | null = null;
      let modifiedAt: string | null = null;
      try {
        // stat 跟随软链接——所以软链接指向目录时 isDirectory 是对的
        const st = await stat(path);
        isDirectory = st.isDirectory();
        // **目录的大小不是 0，是不知道**（事实 G2：读不到的东西不是 0）
        if (!isDirectory) sizeBytes = st.size;
        modifiedAt = st.mtime.toISOString();
      } catch {
        // 读不到就留 null。条目本身仍然有用。
      }
      out.push({ name: dirent.name, path, isDirectory, sizeBytes, modifiedAt });
    }
    return out;
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

  /**
   * 上传：宿主文件系统直写。
   *
   * `remotePath` 是**目录**（统一的语义，见 `connection.ts`）——
   * `copyFile` 要的是完整文件路径，所以这里补上 basename。
   */
  async push(localPath: string, remotePath: string): Promise<void> {
    const target = join(remotePath, basename(localPath));
    try {
      await copyFile(localPath, target);
    } catch (err) {
      throw makeError('FILE_TRANSFER_FAILED', `上传失败：${localPath}`, {
        detail: { localPath, remotePath, target, cause: err instanceof Error ? err.message : String(err) },
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


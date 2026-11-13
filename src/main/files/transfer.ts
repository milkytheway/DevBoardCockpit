import { makeError } from '../../shared/errors';
import type { ConnectionCapabilities, Connection, FileEntry } from '../hal/connection';

/**
 * 文件互传。
 *
 * **不是所有连接都能传文件**——串口传文件没有意义（事实 S7），
 * 串口的 `capabilities()` 不含 `files`，UI 相应禁用文件浏览器。
 * 这个检查做**两道**：UI 禁用入口（防误操作）+ 服务端拒绝（防绕过）。
 */

export type { FileEntry };

export interface FileTransfer {
  list(connectionId: string, remotePath: string): Promise<FileEntry[]>;
  pull(connectionId: string, remotePath: string, localPath: string): Promise<void>;
  push(connectionId: string, localPath: string, remotePath: string): Promise<void>;
}

/** 连接不支持文件传输时抛错 */
export function assertTransferAllowed(caps: ConnectionCapabilities): void {
  if (!caps.files) {
    throw makeError('FILE_TRANSFER_FAILED', '该连接不支持文件传输');
  }
}

export interface TransferServiceOptions {
  /** 按 id 取连接；取不到返回 undefined */
  getConnection(id: string): Connection | undefined;
}

export class TransferService implements FileTransfer {
  constructor(private readonly opts: TransferServiceOptions) {}

  /**
   * 列远端目录。
   *
   * **按传输分派**（计划 Task 9 Step 3）：
   * adb 走 `adb shell ls -la`，ssh 走 sftp 的 readdir，本机走 fs。
   *
   * 原来这里对所有传输都跑一条 `ls -la`——
   * 本机在 Windows 上那是 cmd.exe，**根本没有 ls**，
   * 于是本机连接的文件树永远是空的。
   */
  async list(connectionId: string, remotePath: string): Promise<FileEntry[]> {
    const conn = this.require(connectionId);
    return conn.list(remotePath);
  }

  async pull(connectionId: string, remotePath: string, localPath: string): Promise<void> {
    const conn = this.require(connectionId);
    if (localPath.length === 0) {
      // 空路径会让 `adb pull <remote> ''` / `copyFile(remote, '')` 直接失败，
      // 而且失败信息毫无意义。**宿主必须先定好落盘位置。**
      throw makeError('FILE_TRANSFER_FAILED', '没有本地落盘路径', {
        detail: { remotePath },
      });
    }
    // **按传输分派**：adb 用 `adb pull`，ssh 用 sftp，本机用 fs。
    // 不能跑远端的 `pull` 命令——板子上没有这个命令。
    await conn.pull(remotePath, localPath);
  }

  async push(connectionId: string, localPath: string, remotePath: string): Promise<void> {
    const conn = this.require(connectionId);
    if (localPath.length === 0) {
      throw makeError('FILE_TRANSFER_FAILED', '没有本地源路径', { detail: { remotePath } });
    }
    await conn.push(localPath, remotePath);
  }

  /** 取连接并检查能力位。取不到或不支持都直接拒 */
  private require(connectionId: string): Connection {
    const conn = this.opts.getConnection(connectionId);
    if (!conn) {
      throw makeError('CONN_CLOSED', `连接不存在 ${connectionId}`, { detail: { connectionId } });
    }
    assertTransferAllowed(conn.capabilities());
    return conn;
  }
}

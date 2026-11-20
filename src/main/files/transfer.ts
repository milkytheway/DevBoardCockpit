import { makeError } from '../../shared/errors';
import type { ConnectionCapabilities, Connection, FileEntry } from '../hal/connection';

/**
 * The file transfer.
 *
 * **Not every connection can transfer files** — transferring a file over a
 * serial line makes no sense (fact S7), the `capabilities()` of a serial
 * connection does not contain `files`, and the interface disables the file
 * browser accordingly.
 * This check is made **twice**: the interface disables the entry point (against
 * a misoperation) + the server refuses it (against a bypass).
 */

export type { FileEntry };

export interface FileTransfer {
  list(connectionId: string, remotePath: string): Promise<FileEntry[]>;
  pull(connectionId: string, remotePath: string, localPath: string): Promise<void>;
  push(connectionId: string, localPath: string, remotePath: string): Promise<void>;
}

/** Throws when the connection does not support the file transfer */
export function assertTransferAllowed(caps: ConnectionCapabilities): void {
  if (!caps.files) {
    throw makeError('FILE_TRANSFER_FAILED', 'this connection does not support file transfer');
  }
}

export interface TransferServiceOptions {
  /** Fetches a connection by id; `undefined` when there is none */
  getConnection(id: string): Connection | undefined;
}

export class TransferService implements FileTransfer {
  constructor(private readonly opts: TransferServiceOptions) {}

  /**
     * Lists a remote directory.
     *
     * **Dispatched per transport** (plan task 9, step 3):
     * adb goes through `adb shell ls -la`, ssh through the readdir of sftp, the
     * local one through fs.
     *
     * This used to run one `ls -la` for every transport —
     * on the local transport under Windows that is cmd.exe, which **has no ls
     * at all**,
     * so the file tree of a local connection was always empty.
     */
  async list(connectionId: string, remotePath: string): Promise<FileEntry[]> {
    const conn = this.require(connectionId);
    return conn.list(remotePath);
  }

  async pull(connectionId: string, remotePath: string, localPath: string): Promise<void> {
    const conn = this.require(connectionId);
    if (localPath.length === 0) {
      // An empty path makes `adb pull <remote> ''` / `copyFile(remote, '')` fail right away,
      // and the failure message means nothing. **The host has to decide the destination first.**
      throw makeError('FILE_TRANSFER_FAILED', 'there is no local destination path', {
        detail: { remotePath },
      });
    }
    // **Dispatched per transport**: adb uses `adb pull`, ssh uses sftp, the local one uses fs.
    // The remote `pull` command cannot be run — the board does not have such a command.
    await conn.pull(remotePath, localPath);
  }

  async push(connectionId: string, localPath: string, remotePath: string): Promise<void> {
    const conn = this.require(connectionId);
    if (localPath.length === 0) {
      throw makeError('FILE_TRANSFER_FAILED', 'there is no local source path', { detail: { remotePath } });
    }
    await conn.push(localPath, remotePath);
  }

  /** Fetches the connection and checks the capability. It refuses when it is missing or does not support it */
  private require(connectionId: string): Connection {
    const conn = this.opts.getConnection(connectionId);
    if (!conn) {
      throw makeError('CONN_CLOSED', `the connection does not exist: ${connectionId}`, { detail: { connectionId } });
    }
    assertTransferAllowed(conn.capabilities());
    return conn;
  }
}

import { makeError } from '../../shared/errors';
import type { Capabilities, Connection } from '../hal/connection';

/**
 * 文件互传。
 *
 * **不是所有连接都能传文件**——串口传文件没有意义（事实 S7），
 * 串口的 `capabilities()` 不含 `files`，UI 相应禁用文件浏览器。
 * 这个检查做**两道**：UI 禁用入口（防误操作）+ 服务端拒绝（防绕过）。
 */

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  sizeBytes: number | null;
  modifiedAt: string | null;
}

export interface FileTransfer {
  list(connectionId: string, remotePath: string): Promise<FileEntry[]>;
  pull(connectionId: string, remotePath: string, localPath: string): Promise<void>;
  push(connectionId: string, localPath: string, remotePath: string): Promise<void>;
}

/** 连接不支持文件传输时抛错 */
export function assertTransferAllowed(caps: Capabilities): void {
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

  async list(connectionId: string, remotePath: string): Promise<FileEntry[]> {
    const conn = this.require(connectionId);
    const result = await conn.exec(`ls -la ${remotePath}`);
    if (result.exitCode !== 0) {
      throw makeError('FILE_TRANSFER_FAILED', `列目录失败：${remotePath}`, {
        detail: { remotePath, stderr: result.stderr },
      });
    }
    return parseLsOutput(result.stdout, remotePath);
  }

  async pull(connectionId: string, remotePath: string, localPath: string): Promise<void> {
    const conn = this.require(connectionId);
    // 具体实现按传输分派：adb 用 `adb pull`，ssh 用 sftp
    const result = await conn.exec(`pull ${remotePath} ${localPath}`);
    if (result.exitCode !== 0) {
      throw makeError('FILE_TRANSFER_FAILED', `下载失败：${remotePath}`, {
        detail: { remotePath, localPath, stderr: result.stderr },
      });
    }
  }

  async push(connectionId: string, localPath: string, remotePath: string): Promise<void> {
    const conn = this.require(connectionId);
    const result = await conn.exec(`push ${localPath} ${remotePath}`);
    if (result.exitCode !== 0) {
      throw makeError('FILE_TRANSFER_FAILED', `上传失败：${localPath}`, {
        detail: { localPath, remotePath, stderr: result.stderr },
      });
    }
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

/**
 * `ls -la` 的时间格式是 `Nov 12 09:30` 或 `Nov 12  2024`——
 * **不带年份**，且这个格式 `Date` 解析不了。
 * 所以手工解析：补上当前年份，把月份名换成数字。
 * 解析不出来就返回 null——时间显示不出来不是致命问题，条目本身仍然有用。
 */
export function parseLsDate(text: string): string | null {
  const months: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  const m = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(?:(\d{1,2}):(\d{2})|(\d{4}))$/.exec(text.trim());
  if (!m) return null;
  const month = months[m[1]];
  if (month === undefined) return null;
  const day = Number(m[2]);
  const now = new Date();
  if (m[3] !== undefined) {
    const d = new Date(now.getFullYear(), month, day, Number(m[3]), Number(m[4]));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(Number(m[5]), month, day);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * 解析 `ls -la` 的输出。
 *
 * 只取名字、类型、大小、修改时间——够文件浏览器画树了。
 * 解析不了的行直接跳过：远端的 ls 输出格式各家不同，
 * 一行解析不了不该毁掉整次列举。
 */
export function parseLsOutput(stdout: string, basePath: string): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // -rw-r--r-- 1 root root  1234 Nov 12 09:30 name
    // 日期必须显式匹配（它内部有空格），剩下的才是文件名
    const m = /^([dlbcps-])([rwxstST-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w{3}\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4}))\s+(.+)$/.exec(
      trimmed,
    );
    if (!m) continue;
    const [, type, , size, date, name] = m;
    if (name === '.' || name === '..') continue;
    entries.push({
      name,
      path: `${basePath.replace(/\/$/, '')}/${name}`,
      isDirectory: type === 'd',
      sizeBytes: Number(size),
      modifiedAt: parseLsDate(date),
    });
  }
  return entries;
}

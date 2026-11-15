import { StringDecoder } from 'node:string_decoder';
import { basename, join } from 'node:path';
import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2';
import { makeError } from '../../shared/errors';
import type { FileEntry } from '../../shared/ipc-contract';
import type { SessionLog } from '../logging/session-log';
import type { ConnectionProfile } from '../profiles/schema';
import { Session, TIMEOUT_EXIT_CODE } from './session';
import { capabilitiesFor, transportDefaults } from './capabilities';
import { readFileSync } from 'node:fs';
import type { ConnectionCapabilities, Connection, ExecOptions, ExecResult } from './connection';

/**
 * SSH 传输。
 *
 * **事实 H1**：用 `ssh2`（Node 侧），**不用** `ssh.exe` 脚本——
 * 脚本做不了密码认证。
 *
 * SSH 是 pty 模式：远端提供真终端，自己回显、自己出 ANSI，
 * 所以宿主只转发按键（见 legacy 的两种终端模式）。
 */

export function sshCapabilities(): ConnectionCapabilities {
  return transportDefaults('ssh');
}

/**
 * 读私钥文件（**读成内容**）。
 *
 * 读不到 → **报错**（不是「不带私钥去连」→ 然后莫名其妙地认证失败 ✗）。
 */
function readPrivateKey(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    throw makeError('CONN_OPEN_FAILED', `读不了私钥文件 ${path}`, {
      detail: { path, cause: err instanceof Error ? err.message : String(err) },
    });
  }
}

export interface SshConnectOptions {
  host: string;
  port: number;
  username?: string;
  /** 私钥（**内容**，不是路径——ssh2 认的是钥匙本身 ✓） */
  privateKey?: Buffer | string;
  password?: string;
}

/** 从 profile 里解析连接参数。缺 host 直接报错——连不上要说清是哪个主机。 */
export function sshArgs(profile: ConnectionProfile): SshConnectOptions {
  const host = profile.options['host'];
  if (typeof host !== 'string' || host.length === 0) {
    throw makeError('IPC_INVALID_PAYLOAD', "SSH 连接缺少 'host'", {
      detail: { source: profile.id, field: 'host' },
    });
  }
  const port = Number(profile.options['port'] ?? 22);
  const username = profile.options['username'];
  const keyFilename = profile.options['key_filename'];
  const password = profile.options['password'];

  return {
    host,
    port,
    ...(typeof username === 'string' ? { username } : {}),
    ...(typeof password === 'string' ? { password } : {}),
    // **私钥要读成内容（Buffer），不能只给路径**——
    // ssh2 的 `privateKey` 收的是**钥匙本身**；给路径它会当成钥匙内容去解析
    // → 「Unsupported key format」（2026-11-15 真机实测撞到的）。
    ...(typeof keyFilename === 'string' ? { privateKey: readPrivateKey(keyFilename) } : {}),
  };
}

export interface SshConnectionOptions {
  /** 注入 ssh2 客户端，测试用 */
  clientFactory?: (opts: SshConnectOptions) => Client;
}

/**
 * sftp 的 readdir 回包一项。
 *
 * ssh2 给的类型是 `FileEntryWithStats`（attrs 必带一堆方法），
 * 但真实服务端不一定给全——这里只声明我们真正用到的三个字段，
 * 缺的按「拿不到」处理，不假装有。
 */
interface SftpDirEntry {
  filename: string;
  longname?: string;
  attrs?: {
    /** POSIX 模式：高位是文件类型位 */
    mode?: number;
    size?: number;
    /** **秒**，不是毫秒 */
    mtime?: number;
  };
}

/**
 * sftp 的一项 → 契约里的 `FileEntry`。
 *
 * **目录的 sizeBytes 是 null**（读不到的东西不是 0 —— 事实 G2）：
 * `ls -la` 里目录那个 4096 是文件系统给目录分配的块数，不是它的「大小」，
 * 当成文件大小显示出来是骗人。
 */
function toFileEntry(entry: SftpDirEntry, remotePath: string): FileEntry {
  const attrs = entry.attrs ?? {};
  const mode = typeof attrs.mode === 'number' ? attrs.mode : undefined;

  // 目录判定：POSIX 模式的高位是文件类型位（0o170000），0o040000 = 目录。
  // mode 拿不到（缺省或 0——0 不是任何合法文件类型的模式）就退回看 longname
  // 的首字符，那是 ls -l 那套记号（d 目录 / - 文件 / l 软链接）。
  const isDirectory =
    mode !== undefined && mode > 0
      ? (mode & 0o170000) === 0o040000
      : (entry.longname ?? '').charAt(0) === 'd';

  // sftp 的 mtime 是**秒**（不是毫秒）——当成毫秒会差出一千倍。
  // mtime 为 0 是「服务端没给时间戳」，不是 1970 年：显示成 1970 是骗人，
  // 所以按「读不到」给 null（与 sizeBytes 同一条原则，事实 G2）。
  const mtime = typeof attrs.mtime === 'number' && Number.isFinite(attrs.mtime) ? attrs.mtime : undefined;
  const modifiedAt = mtime !== undefined && mtime > 0 ? new Date(mtime * 1000).toISOString() : null;

  const size = typeof attrs.size === 'number' ? attrs.size : null;

  return {
    name: entry.filename,
    // remotePath 末尾的斜杠去掉再拼，免得变成 `/root//a.txt`
    path: `${remotePath.replace(/\/+$/, '')}/${entry.filename}`,
    isDirectory,
    sizeBytes: isDirectory ? null : size,
    modifiedAt,
  };
}

export class SshConnection implements Connection {
  readonly id: string;
  readonly transport = 'ssh' as const;

  private client: Client | undefined;
  private readonly opts: SshConnectOptions;
  /** 最近一次链路错误。供上层查连接健康度 */
  lastError: Error | undefined;

  constructor(
    private readonly profile: ConnectionProfile,
    private readonly log: SessionLog,
    private readonly options: SshConnectionOptions = {},
  ) {
    this.id = profile.id;
    this.opts = sshArgs(profile);
  }

  capabilities(): ConnectionCapabilities {
    // **profile 感知**——不是传输常量（见 `capabilities.ts` 的说明）。
    return capabilitiesFor(this.profile);
  }

  async open(): Promise<void> {
    const client = this.options.clientFactory
      ? this.options.clientFactory(this.opts)
      : new Client();

    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        resolve();
      };
      const onError = (err: Error & { level?: string }): void => {
        // 连接建立之后的错误（链路断了）也要有人接——
        // 没有监听器的 'error' 事件会变成未捕获异常，把主进程带崩。
        if (this.client) {
          this.lastError = err;
        } else {
          reject(
            makeError('CONN_OPEN_FAILED', `SSH 连不上 ${this.opts.host}:${this.opts.port}`, {
              detail: { host: this.opts.host, port: this.opts.port, cause: err.message, level: err.level },
            }),
          );
        }
      };
      client.once('ready', onReady);
      // 常驻监听：握手之后不再摘掉
      client.on('error', onError);
      client.connect(this.opts);
    });

    this.client = client;
  }

  async close(): Promise<void> {
    this.client?.end();
    this.client = undefined;
  }

  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    if (!this.client) {
      throw makeError('CONN_CLOSED', 'SSH 连接未打开', { detail: { id: this.id } });
    }
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const startedAt = Date.now();

    return new Promise<ExecResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let stream: ClientChannel | undefined;

      // **跨 chunk 重组**（约束 G15 / 风险 RF-3）：
      // 一个中文字符可能被拆到两个 chunk 里，`Buffer.toString('utf8')` 是逐 chunk
      // 独立解码的——那样会得到两个 U+FFFD，合法内容被静默损坏。
      // 串口（serial.ts）与 ADB（adb.ts）都用 StringDecoder，SSH 也得用。
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');

      /** 结算一次。重复调用无效——超时与 close 可能同时到 */
      const settle = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts?.signal?.removeEventListener('abort', onAbort);
        // 冲尾巴：最后一个 chunk 的尾巴可能还缓在 decoder 里
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        resolve({
          exitCode: timedOut ? TIMEOUT_EXIT_CODE : code,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          timedOut,
          ...(cancelled ? { cancelled: true } : {}),
        });
      };

      /**
       * 超时**只关那一条通道**，不拆整条连接。
       *
       * 原来这里调的是 `this.client.end()`——那会把该 client 上
       * **所有通道**一起关掉：用户正用着的交互终端当场断掉，
       * 而连接已经死了却仍被当成「已打开」（`this.client` 没置空），
       * 后续每条命令都往死连接上打。
       */
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          stream?.close();
        } catch {
          // 通道已经关了就算了
        }
        // 超时要**自己结算**：远端不主动关通道的话，
        // 光靠 close 事件这个 Promise 永不 settle，调用方永久挂起。
        settle(TIMEOUT_EXIT_CODE);
      }, timeoutMs);

      // ── 取消：**关掉那一条通道** ──
      // → 与超时同款（只关通道，不拆整条连接 ✓ —— 否则用户的交互终端会当场断掉 ✗）
      const onAbort = (): void => {
        if (settled) return;
        cancelled = true;
        try {
          stream?.close();
        } catch {
          // 通道已经关了就算了
        }
        // **自己结算**：远端不主动关通道的话，这个 Promise 永不 settle ✗
        settle(null);
      };
      if (opts?.signal !== undefined) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      this.client!.exec(command, (err, ch) => {
        if (err) {
          clearTimeout(timer);
          opts?.signal?.removeEventListener('abort', onAbort);
          reject(makeError('CONN_OPEN_FAILED', `SSH 执行失败：${err.message}`, {
            detail: { host: this.opts.host, cause: err.message },
          }));
          return;
        }
        stream = ch;
        stream.on('data', (d: Buffer) => { stdout += stdoutDecoder.write(d); });
        stream.stderr.on('data', (d: Buffer) => { stderr += stderrDecoder.write(d); });
        stream.on('close', (code: number | null) => settle(code));
      });
    });
  }

  /**
   * 下载：走 ssh2 的 sftp。
   *
   * **不是**远端的 `pull` 命令——远端 shell 里没有那个命令。
   */
  async pull(remotePath: string, localPath: string): Promise<void> {
    const sftp = await this.openSftp();
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.fastGet(remotePath, localPath, (err) => {
          if (err) {
            reject(makeError('FILE_TRANSFER_FAILED', `下载失败：${remotePath}`, {
              detail: { remotePath, localPath, cause: err.message },
            }));
            return;
          }
          resolve();
        });
      });
    } finally {
      // 失败也要关——否则每失败一次就漏一个 sftp 通道
      sftp.end();
    }
  }

  /**
   * 上传：走 ssh2 的 sftp。
   *
   * `remotePath` 是**目录**（统一的语义，见 `connection.ts`）——
   * `fastPut` 要的是完整文件路径，所以这里补上 basename。
   */
  async push(localPath: string, remotePath: string): Promise<void> {
    const target = join(remotePath, basename(localPath));
    const sftp = await this.openSftp();
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.fastPut(localPath, target, (err) => {
          if (err) {
            reject(makeError('FILE_TRANSFER_FAILED', `上传失败：${localPath}`, {
              detail: { localPath, remotePath, target, cause: err.message },
            }));
            return;
          }
          resolve();
        });
      });
    } finally {
      sftp.end();
    }
  }

  /**
   * 列远端目录。
   *
   * **走 ssh2 的 sftp**（计划 Task 9 Step 3：「adb 用 `adb shell ls -la`，
   * ssh 用 ssh2 的 `sftp`」）——**不是**跑一条远端的 `ls`。
   * 那是 adb 那条线的做法；SSH 这边有 sftp 通道，就用它。
   */
  async list(remotePath: string): Promise<FileEntry[]> {
    const sftp = await this.openSftp();
    try {
      const entries = await new Promise<SftpDirEntry[]>((resolve, reject) => {
        sftp.readdir(remotePath, (err, list) => {
          if (err) {
            reject(makeError('FILE_TRANSFER_FAILED', `列目录失败：${remotePath}`, {
              detail: { remotePath, cause: err.message },
            }));
            return;
          }
          resolve(list);
        });
      });
      return entries.map((entry) => toFileEntry(entry, remotePath));
    } finally {
      // 用完就关（同 pull / push）。**失败也要关**——
      // sftp 通道挂在连接上，漏一条就会一直占着。
      sftp.end();
    }
  }

  /** 打开一条 sftp 通道 */
  private openSftp(): Promise<SFTPWrapper> {
    return new Promise((resolve, reject) => {
      if (!this.client) {
        reject(makeError('CONN_CLOSED', 'SSH 连接未打开'));
        return;
      }
      this.client.sftp((err, sftp) => {
        if (err) {
          reject(makeError('FILE_TRANSFER_FAILED', `开 sftp 失败：${err.message}`, {
            detail: { host: this.opts.host, cause: err.message },
          }));
          return;
        }
        resolve(sftp);
      });
    });
  }

  async openSession(opts?: { cols?: number; rows?: number }): Promise<Session> {
    if (!this.client) {
      throw makeError('CONN_CLOSED', 'SSH 连接未打开', { detail: { id: this.id } });
    }
    // ssh2 的 shell() 是**异步**的：通道要等一次往返才拿到。
    // 同步检查 channel 必然是 undefined——SSH 终端开不起来。
    const channel = await this.openShell(opts?.cols ?? 80, opts?.rows ?? 24);
    return new SshSession(channel, this.log);
  }

  /** 打开一个 shell 通道 */
  private openShell(cols: number, rows: number): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      this.client!.shell({ term: 'xterm-256color', cols, rows }, (err, ch) => {
        if (err) {
          reject(makeError('CONN_OPEN_FAILED', `SSH 开 shell 失败：${err.message}`, {
            detail: { host: this.opts.host, cause: err.message },
          }));
          return;
        }
        resolve(ch);
      });
    });
  }

}

/** SSH 的交互式会话。远端自己回显并出 ANSI，宿主只转发按键 */
class SshSession extends Session {
  /**
   * 跨 chunk 重组多字节字符（约束 G15 / 风险 RF-3）。
   *
   * 挂在会话实例上——一条会话一条 decoder，
   * 否则两个终端各收各的字节，凑不出一个完整的字符。
   */
  private readonly decoder = new StringDecoder('utf8');
  private readonly dataCbs: ((chunk: string) => void)[] = [];
  /** 通道上只挂一个 data 监听：decoder.write 每块字节只能调一次 */
  private listening = false;

  constructor(
    private readonly channel: ClientChannel,
    log: SessionLog,
  ) {
    super(log);
  }

  readonly exitCode: number | null = null;

  write(data: string): void {
    this.channel.write(data);
  }

  onData(cb: (chunk: string) => void): void {
    this.dataCbs.push(cb);
    if (this.listening) return;
    this.listening = true;
    this.channel.on('data', (d: Buffer) => {
      const chunk = this.decoder.write(d);
      // 空串 = 这块字节只带了半个字符，等下一块再说。
      // 直接吐出去会把半个字符变成 U+FFFD。
      if (chunk.length === 0) return;
      for (const c of this.dataCbs) c(chunk);
    });
  }

  resize(cols: number, rows: number): void {
    this.channel.setWindow(rows, cols, 0, 0);
  }

  /**
   * 远端 shell 自己退出了 → 上报。
   *
   * 没有它的话，用户敲了 `exit` 之后界面还留着标签页，
   * 继续打字写进一个**已经死了**的通道——
   * 「板子掉线了但界面不知道」。
   */
  onExit(cb: (exitCode: number | null) => void): void {
    this.channel.on('close', (code: number | null) => cb(code));
  }

  close(): void {
    // 冲尾巴：远端可能只发了半个字符就断线了，那半个字符要显示成替换符，
    // 不能悄悄丢掉（丢一半比显示成 � 更容易让人误判屏幕内容）。
    const tail = this.decoder.end();
    if (tail.length > 0) {
      for (const c of this.dataCbs) c(tail);
    }
    this.channel.close();
  }
}

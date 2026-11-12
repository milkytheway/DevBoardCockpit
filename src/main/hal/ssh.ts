import { Client, type ClientChannel } from 'ssh2';
import { makeError } from '../../shared/errors';
import type { SessionLog } from '../logging/session-log';
import type { ConnectionProfile } from '../profiles/schema';
import { Session, TIMEOUT_EXIT_CODE } from './session';
import type { Capabilities, Connection, ExecResult } from './connection';

/**
 * SSH 传输。
 *
 * **事实 H1**：用 `ssh2`（Node 侧），**不用** `ssh.exe` 脚本——
 * 脚本做不了密码认证。
 *
 * SSH 是 pty 模式：远端提供真终端，自己回显、自己出 ANSI，
 * 所以宿主只转发按键（见 legacy 的两种终端模式）。
 */

export function sshCapabilities(): Capabilities {
  return { exec: true, pty: true, files: true, exitCode: true };
}

export interface SshConnectOptions {
  host: string;
  port: number;
  username?: string;
  privateKey?: string;
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
    ...(typeof keyFilename === 'string' ? { privateKey: keyFilename } : {}),
  };
}

export interface SshConnectionOptions {
  /** 注入 ssh2 客户端，测试用 */
  clientFactory?: (opts: SshConnectOptions) => Client;
}

export class SshConnection implements Connection {
  readonly id: string;
  readonly transport = 'ssh' as const;

  private client: Client | undefined;
  private readonly opts: SshConnectOptions;
  /** 最近一次链路错误。供上层查连接健康度 */
  lastError: Error | undefined;

  constructor(
    profile: ConnectionProfile,
    private readonly log: SessionLog,
    private readonly options: SshConnectionOptions = {},
  ) {
    this.id = profile.id;
    this.opts = sshArgs(profile);
  }

  capabilities(): Capabilities {
    return sshCapabilities();
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

  async exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    if (!this.client) {
      throw makeError('CONN_CLOSED', 'SSH 连接未打开', { detail: { id: this.id } });
    }
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const startedAt = Date.now();

    return new Promise<ExecResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        this.client?.end();
      }, timeoutMs);

      this.client!.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          reject(makeError('CONN_OPEN_FAILED', `SSH 执行失败：${err.message}`, {
            detail: { host: this.opts.host, cause: err.message },
          }));
          return;
        }
        stream.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
        stream.on('close', (code: number | null) => {
          clearTimeout(timer);
          resolve({
            exitCode: timedOut ? TIMEOUT_EXIT_CODE : code,
            stdout,
            stderr,
            durationMs: Date.now() - startedAt,
            timedOut,
          });
        });
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
    this.channel.on('data', (d: Buffer) => cb(d.toString('utf8')));
  }

  resize(cols: number, rows: number): void {
    this.channel.setWindow(rows, cols, 0, 0);
  }

  close(): void {
    this.channel.close();
  }
}

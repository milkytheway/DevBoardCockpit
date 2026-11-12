import { StringDecoder } from 'node:string_decoder';
import { SerialPort } from 'serialport';
import { makeError } from '../../shared/errors';
import type { SessionLog } from '../logging/session-log';
import type { ConnectionProfile } from '../profiles/schema';
import { buildMarker, extractMarkerOutput, Session, TIMEOUT_EXIT_CODE } from './session';
import type { Capabilities, Connection, ExecResult } from './connection';

/**
 * 串口传输。
 *
 * 串口的三个硬事实（`docs/02-设备事实清单.md`）：
 *
 * - **S1 单通道**：命令通道和交互终端共用一根线，一个读线程 + 一份 transcript。
 * - **S5 没有退出码**：有文本回包 = 0，超时 = 124。
 * - **S7 传不了文件**：`capabilities()` 不含 `files`，UI 相应禁用文件浏览器。
 *
 * 另外两条：**S2** 板子会回显命令，marker 在 transcript 里出现两次；
 * **S4** getty 期待 CR，发送时 `\n` → `\r\n`。
 */

/**
 * 串口是**控制台**：真终端，自己回显、自己出提示符。
 *
 * 这不是我的判断，是三处一致：
 * - legacy 架构说明：「A target that runs a real terminal -- `ssh`, **or a serial
 *   console** -- gives the user a prompt, an echo and line editing」
 * - 本仓库自己的 `profiles/targets/board-serial.json` 写着 `"pty": true`
 * - 事实 S2 说板子**回显**命令——回显是真终端的行为
 *
 * 计划的能力表把串口写成 `pty: false`，与这三条冲突，是计划错了。
 * 串口传不了文件（事实 S7）、拿不到退出码（事实 S5）——这两条不变。
 */
export function serialCapabilities(): Capabilities {
  return { exec: true, pty: true, files: false, exitCode: false };
}

/**
 * 串口端口的最小抽象——只为可测，真实实现包一层 serialport。
 *
 * `close` 是**异步**的：serialport 的 `close()` 要等 `close` 事件才真的关完，
 * 同步返回会导致「关完就报错」。
 */
export interface SerialPortLike {
  write(data: string): void;
  onData(cb: (chunk: string) => void): void;
  /** 底层出错时通知（拔线、驱动异常） */
  onError(cb: (err: Error) => void): void;
  close(): Promise<void>;
}

/**
 * 打开一个串口。**必须真的打开端口**——
 * `new SerialPort({autoOpen: false})` 只是构造，之后 write 会因为「端口没开」抛错，
 * 而那个错没人监听 → 主进程崩。
 */
export type SerialPortFactory = (opts: { path: string; baudRate: number }) => Promise<SerialPortLike>;

const DEFAULT_TIMEOUT_MS = 30_000;

/** 真实实现：serialport 的 SerialPort 适配成 SerialPortLike */
const realPortFactory: SerialPortFactory = async ({ path, baudRate }) => {
  const port = new SerialPort({ path, baudRate, autoOpen: false });
  // 坏字节不废掉整条命令（事实 A8）——用 StringDecoder 跨 chunk 重组，
  // 否则一个多字节字符被拆到两个 chunk 时会变成两个 U+FFFD。
  const decoder = new StringDecoder('utf8');
  const listeners: ((chunk: string) => void)[] = [];
  const errorListeners: ((err: Error) => void)[] = [];

  port.on('data', (buf: Buffer) => {
    const chunk = decoder.write(buf);
    if (chunk.length === 0) return;
    for (const cb of listeners) cb(chunk);
  });
  port.on('error', (err: Error) => {
    for (const cb of errorListeners) cb(err);
  });

  await port.open();

  return {
    write(data: string) {
      port.write(data);
    },
    onData(cb: (chunk: string) => void) {
      listeners.push(cb);
    },
    onError(cb: (err: Error) => void) {
      errorListeners.push(cb);
    },
    async close() {
      if (!port.isOpen) return;
      await new Promise<void>((resolve) => {
        port.close(() => resolve());
      });
    },
  };
};

export class SerialConnection implements Connection {
  readonly id: string;
  readonly transport = 'serial' as const;

  private port: SerialPortLike | undefined;
  private transcript = '';
  private dataCb: ((chunk: string) => void) | undefined;
  /** 最近一次端口层错误（拔线、驱动异常）。供上层查连接健康度 */
  lastError: Error | undefined;

  constructor(
    private readonly profile: ConnectionProfile,
    private readonly log: SessionLog,
    private readonly portFactory: SerialPortFactory = realPortFactory,
  ) {
    this.id = profile.id;
  }

  capabilities(): Capabilities {
    return serialCapabilities();
  }

  async open(): Promise<void> {
    const port = this.profile.options['port'];
    const baudRate = Number(this.profile.options['baudrate'] ?? 115200);

    try {
      this.port = await this.portFactory({ path: String(port), baudRate });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string } | undefined)?.code;
      const busy = code === 'EBUSY' || /busy|denied/i.test(message);
      if (busy) {
        // RF-5：要说清是哪个端口被占，而不是笼统的「打开失败」
        throw makeError('PORT_BUSY', `串口 ${String(port)} 被占用`, {
          detail: { port: String(port) },
        });
      }
      throw makeError('CONN_OPEN_FAILED', `打不开串口 ${String(port)}`, {
        detail: { port: String(port), cause: message },
      });
    }

    this.port.onData((chunk) => {
      this.transcript += chunk;
      this.trimTranscript();
      this.dataCb?.(chunk);
    });

    // 端口层出错（拔线、驱动异常）要有去处——
    // 没有监听器的 'error' 事件会变成未捕获异常，把主进程带崩。
    this.port.onError((err) => {
      this.lastError = err;
    });
  }

  async close(): Promise<void> {
    await this.port?.close();
    this.port = undefined;
  }

  /**
   * 跑一条命令。
   *
   * 走 marker 协议：发命令 → 在 transcript 里认领回包。
   * **有文本回包 = 0；超时 = 124**（事实 S5）——串口拿不到 exit status。
   */
  async exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    if (!this.port) {
      throw makeError('CONN_CLOSED', '串口未打开', { detail: { id: this.id } });
    }

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();
    const marker = buildMarker(process.pid, Date.now());

    const before = this.transcript.length;
    // **一行协议**（事实 S2）。
    //
    // 板子会**回显命令**，所以同一个 marker 在 transcript 里出现**两次**：
    //   第一次 = 回显的那一行里（`command; echo marker` 被回显出来）
    //   第二次 = 命令跑完后 echo 打印出来
    // 取两次之间的内容就是命令的输出。
    //
    // 如果把 marker 单独发一行，板子会先执行 `marker` 这个命令
    // （sh: marker: not found），输出全错。
    //
    // 事实 S4：getty 期待 CR，只发 \n 可能不换行
    this.port.write(`${command}; echo ${marker}\r\n`);

    const output = await this.waitForMarker(marker, before, timeoutMs);
    const timedOut = output === undefined;

    return {
      exitCode: timedOut ? TIMEOUT_EXIT_CODE : 0,
      stdout: timedOut ? '' : output,
      stderr: '',
      durationMs: Date.now() - startedAt,
      timedOut,
    };
  }

  /** 串口传不了文件（事实 S7） */
  async pull(_remotePath: string, _localPath: string): Promise<void> {
    throw makeError('FILE_TRANSFER_FAILED', '串口不支持文件传输');
  }

  /** 串口传不了文件（事实 S7） */
  async push(_localPath: string, _remotePath: string): Promise<void> {
    throw makeError('FILE_TRANSFER_FAILED', '串口不支持文件传输');
  }

  async openSession(_opts?: { cols?: number; rows?: number }): Promise<Session> {
    if (!this.port) {
      throw makeError('CONN_CLOSED', '串口未打开', { detail: { id: this.id } });
    }
    return new SerialSession(this.port, this.log);
  }

  /** 等 marker 出现第二次。返回输出文本；超时返回 undefined */
  private waitForMarker(marker: string, from: number, timeoutMs: number): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const check = (): void => {
        const chunk = this.transcript.slice(from);
        // marker 出现两次才算收齐（板子回显一次 + 输出后一次）
        if (chunk.split(marker).length - 1 >= 2) {
          resolve(extractMarkerOutput(chunk, marker));
          return;
        }
        if (Date.now() > deadline) {
          resolve(undefined);
          return;
        }
        setTimeout(check, 20);
      };
      check();
    });
  }

  /**
   * transcript 只用来认领最近的回包，不必无限增长。
   * 留 64 KB 足够装下任何一次命令的输出。
   */
  private trimTranscript(): void {
    const MAX = 64 * 1024;
    if (this.transcript.length > MAX) {
      this.transcript = this.transcript.slice(this.transcript.length - MAX);
    }
  }
}

/** 串口的交互式会话。串口是 pipe 模式：板子不回显，宿主自己回显 */
class SerialSession extends Session {
  constructor(
    private readonly port: SerialPortLike,
    log: SessionLog,
  ) {
    super(log);
  }

  /** 串口拿不到退出码（事实 S5） */
  readonly exitCode: number | null = null;

  write(data: string): void {
    this.port.write(data);
    this.record(data);
  }

  onData(cb: (chunk: string) => void): void {
    this.port.onData(cb);
  }

  resize(_cols: number, _rows: number): void {
    // 串口没有窗口尺寸概念
  }

  close(): void {
    void this.port.close();
  }
}


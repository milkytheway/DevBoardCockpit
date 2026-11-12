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

export function serialCapabilities(): Capabilities {
  return { exec: true, pty: false, files: false, exitCode: false };
}

/** 串口端口的最小抽象——只为可测，真实实现包一层 serialport */
export interface SerialPortLike {
  write(data: string): void;
  onData(cb: (chunk: string) => void): void;
  close(): void;
}

export type SerialPortFactory = (opts: { path: string; baudRate: number }) => SerialPortLike;

const DEFAULT_TIMEOUT_MS = 30_000;

/** 真实实现：serialport 的 SerialPort 适配成 SerialPortLike */
const realPortFactory: SerialPortFactory = ({ path, baudRate }) => {
  const port = new SerialPort({ path, baudRate, autoOpen: false });
  return {
    write(data: string) {
      port.write(data);
    },
    onData(cb: (chunk: string) => void) {
      port.on('data', (buf: Buffer) => {
        // 坏字节不废掉整条命令（事实 A8）
        cb(buf.toString('utf8'));
      });
    },
    close() {
      port.close();
    },
  };
};

export class SerialConnection implements Connection {
  readonly id: string;
  readonly transport = 'serial' as const;

  private port: SerialPortLike | undefined;
  private transcript = '';
  private dataCb: ((chunk: string) => void) | undefined;

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
      this.port = this.portFactory({ path: String(port), baudRate });
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
      this.dataCb?.(chunk);
    });
  }

  async close(): Promise<void> {
    this.port?.close();
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
    // 事实 S4：getty 期待 CR，只发 \n 可能不换行
    this.port.write(`${marker}\r\n${command}\r\n${marker}\r\n`);

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

  openSession(_opts?: { cols?: number; rows?: number }): Session {
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

  resize(_cols: number, _rows: number): void {
    // 串口没有窗口尺寸概念
  }

  close(): void {
    this.port.close();
  }
}

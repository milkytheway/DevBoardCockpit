import { StringDecoder } from 'node:string_decoder';
import { SerialPort } from 'serialport';
import { makeError } from '../../shared/errors';
import type { SessionLog } from '../logging/session-log';
import type { ConnectionProfile } from '../profiles/schema';
import { buildMarker, extractMarkerOutput, Session, TIMEOUT_EXIT_CODE } from './session';
import { capabilitiesFor, transportDefaults } from './capabilities';
import type { ConnectionCapabilities, Connection, ExecResult, FileEntry, ExecOptions } from './connection';

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
export function serialCapabilities(): ConnectionCapabilities {
  return transportDefaults('serial');
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
/**
 * 真实的串口工厂。
 *
 * **导出是为了能被测。** 之前的实现在模块内私有，于是「端口到底开没开」
 * 这件事**现在有测试守着**了——把 `await port.open()` 删掉，
 * `tests/unit/serial-real-factory.test.ts` 会立刻变红（变异守卫 M40）。
 * 而那正是整支评审的 C1：端口不开，用户第一次按键就崩主进程。
 */
export const realPortFactory: SerialPortFactory = async ({ path, baudRate }) => {
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
  /** 最近一次端口层错误（拔线、驱动异常）。供上层查连接健康度 */
  lastError: Error | undefined;
  /**
   * 本次 exec 的回包缓冲。`undefined` = 当前没有命令在跑。
   *
   * **为什么是「本次的」而不是「共享的一份 transcript」**：
   * 原来用 `transcript.length` 当绝对下标，认领时 `slice(from)`。
   * 但 transcript 会被裁剪（64 KB 上限），下标一旦失效就永远认不回来——
   * 大输出（`cat` 大文件、`ls -la` 大目录）之后，**这条连接上的 exec 通道永久死亡**。
   *
   * 改成「每次 exec 用自己的缓冲，只装命令发出之后到达的数据」，
   * 就**没有下标这回事**了：缓冲天生只含本次命令的回包。
   */
  private execBuffer: string | undefined;
  /**
   * 往返互斥（契约 `spec/02` §1.2.1 + 事实 S1）。
   *
   * 串口只有一根线、一个读线程。命令通道和交互终端**共用一根线**——
   * 所以同一连接上同时只能有一次往返。
   *
   * 原来这把锁只挡 exec↔exec：交互会话开着的时候，
   * 任何一次 exec 都会把命令**追加在用户没打完的输入后面**
   * （板端 shell 拿到的是 `ls -l /tmpuptime; echo marker`）。
   */
  private busy = false;

  constructor(
    private readonly profile: ConnectionProfile,
    private readonly log: SessionLog,
    private readonly portFactory: SerialPortFactory = realPortFactory,
  ) {
    this.id = profile.id;
  }

  capabilities(): ConnectionCapabilities {
    // **profile 感知**——不是传输常量（见 `capabilities.ts` 的说明）。
    return capabilitiesFor(this.profile);
  }

  async open(): Promise<void> {
    const port = this.profile.options['port'];
    const baudRate = Number(this.profile.options['baudrate'] ?? 115200);

    // 重复 open 会覆盖 `this.port`，**前一个端口句柄就泄漏了**。
    // 先把旧的关掉。
    if (this.port) {
      await this.port.close();
      this.port = undefined;
    }

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
      // 只往「本次命令的缓冲」里塞。缓冲在命令发出前清空，
      // 所以它天生只含本次命令的回包——不需要下标。
      if (this.execBuffer !== undefined) this.execBuffer += chunk;
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
    this.execBuffer = undefined;
    this.busy = false;
  }

  /**
   * 跑一条命令。
   *
   * 走 marker 协议：发命令 → 在 transcript 里认领回包。
   * **有文本回包 = 0；超时 = 124**（事实 S5）——串口拿不到 exit status。
   */
  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    if (!this.port) {
      throw makeError('CONN_CLOSED', '串口未打开', { detail: { id: this.id } });
    }
    if (this.busy) {
      // 同一连接上并发往返 = 串台。宁可拒绝，也不能让两个命令互相认领对方的输出。
      // **不是超时，是「被拒」**：两者不该同码——
      // UI 分不清「等久了没结果」与「这条线正忙着」。
      throw makeError('CONN_BUSY', '这条连接上还有命令在跑', {
        detail: { id: this.id, command },
      });
    }
    this.busy = true;
    try {
      return await this.execLocked(command, opts);
    } finally {
      this.busy = false;
    }
  }

  private async execLocked(command: string, opts?: ExecOptions): Promise<ExecResult> {

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();
    const marker = buildMarker(process.pid, Date.now());

    // 本次命令的回包缓冲：清空后再发命令，
    // 于是缓冲里只有「命令发出之后到达的数据」。
    this.execBuffer = '';
    try {
      // **一行协议**（事实 S2）。
      //
      // 板子会**回显命令**，所以同一个 marker 在回包里出现**两次**：
      //   第一次 = 回显的那一行里（`command; echo marker` 被回显出来）
      //   第二次 = 命令跑完后 echo 打印出来
      // 取两次之间的内容就是命令的输出。
      //
      // 如果把 marker 单独发一行，板子会先执行 `marker` 这个命令
      // （sh: marker: not found），输出全错。
      //
      // 事实 S4：getty 期待 CR，只发 \n 可能不换行
      this.port?.write(`${command}; echo ${marker}\r\n`);

      const output = await this.waitForMarker(marker, timeoutMs, opts?.signal);
      const timedOut = output === undefined;
      // **取消**与**超时**分开 ✓（串口上没有退出码 ✓，只能用标记区分 ✓）
      const cancelled = output === undefined && opts?.signal?.aborted === true;

      const portName = this.profile.options['port'];
      return {
        exitCode: timedOut ? TIMEOUT_EXIT_CODE : 0,
        stdout: timedOut ? '' : output,
        stderr: '',
        durationMs: Date.now() - startedAt,
        timedOut: timedOut && !cancelled,
        ...(cancelled ? { cancelled: true } : {}),
        // 超时的**第一嫌疑**是「回包被别的程序吃了」，不是「板子慢」。
        //
        // 真机上真踩过（2026-11-13）：宿主上计划 1 验收留下的 `serial-server.py`
        // **独占打开了 COM3** —— 板子是活的、串口是通的，
        // 但**回包被它吃掉**，所以应用自己的 exec 永远等不到。
        // 不说清楚，人就会往「板子是不是死了」的方向查。
        ...(timedOut && !cancelled
          ? {
              hint:
                `串口 ${String(portName)} 一次往返超时。` +
                '**最常见的原因是回包被另一个程序吃掉了**' +
                '（例如计划 1 验收留下的 serial-server.py 独占着这个口）——' +
                `先确认 ${String(portName)} 没有被别的程序占用。`,
            }
          : {}),
      };
    } finally {
      this.execBuffer = undefined;
    }
  }

  /** 串口传不了文件（事实 S7） */
  async list(_remotePath: string): Promise<FileEntry[]> {
    throw makeError('FILE_TRANSFER_FAILED', '串口不支持文件传输');
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
    if (this.busy) {
      // 同一根线上已经有一次往返了（事实 S1：命令通道与交互终端共用一根线）。
      // 宁可拒绝，也不能把命令追加在用户没打完的输入后面。
      throw makeError('CONN_BUSY', '这条连接上已经有命令在跑', {
        detail: { id: this.id },
      });
    }
    // 交互会话占住这条线，直到它关闭
    this.busy = true;
    return new SerialSession(this.port, this.log, () => {
      this.busy = false;
    });
  }

  /** 等 marker 出现第二次。返回输出文本；超时返回 undefined */
  private waitForMarker(
    marker: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const check = (): void => {
        const chunk = this.execBuffer ?? '';
        // marker 出现两次才算收齐（板子回显一次 + 输出后一次）
        if (chunk.split(marker).length - 1 >= 2) {
          resolve(extractMarkerOutput(chunk, marker));
          return;
        }
        // **被取消了 → 明确放弃** ✓（契约 §5.2 的「放弃等这个 marker」✓）
        // → 串口上**没法杀远端的进程** ✓（那不是一条 shell 连接 ✗）
        // → 至少**宿主不等了** ✓（尖兵实测：收到取消后照跑完 ✗ —— 就是因为宿主还在等 ✗）
        if (signal?.aborted === true) {
          resolve(undefined);
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

/**
 * 串口的交互式会话。
 *
 * **端口归连接所有，会话不关它**——关会话是连接的职责（`connection.close()`）。
 * 会话只负责释放那把「往返互斥」的锁。
 */
class SerialSession extends Session {
  constructor(
    private readonly port: SerialPortLike,
    log: SessionLog,
    /** 会话关闭时的回调。用来释放连接的往返互斥锁 */
    private readonly onClose: () => void,
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
    this.onClose();
  }
}


import type { Session } from './session';
import type { TransportKind } from '../profiles/schema';

/**
 * 连接层的公共接口。
 *
 * 四种传输（串口 / ADB / SSH / 本机）实现同一套接口，
 * UI 与能力层因此不需要知道自己连的是哪种线——
 * 这就是「统一工作台」在代码层面的落点。
 */

/**
 * 能力位。**UI 依能力降级**，不依传输名。
 *
 * 旧工程吃过这个亏：终端模式（pty/pipe）曾由传输名推断，
 * 新注册的传输就被当成了真终端。这里把能力显式化。
 */
export interface Capabilities {
  /** 能跑一条命令拿结果 */
  exec: boolean;
  /** 能开交互式终端（真 pty，有回显与 ANSI） */
  pty: boolean;
  /** 能做文件传输 */
  files: boolean;
  /**
   * exec 能否拿到退出码。
   * 串口为 false——它拿不到 exit status（事实 S5）。
   * 没有这个位，运行时就得靠猜「这条命令成功了吗」。
   */
  exitCode: boolean;
}

export interface ExecResult {
  /** null = 拿不到（串口）。超时一律是 124 */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface Connection {
  readonly id: string;
  readonly transport: TransportKind;
  capabilities(): Capabilities;
  open(): Promise<void>;
  close(): Promise<void>;
  exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
  /** 打开一个交互式会话（终端用）。pipe 模式的会话不回显，pty 模式的会。 */
  openSession(opts?: { cols?: number; rows?: number }): Session;
}

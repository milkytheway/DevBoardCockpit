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
 *
 * 定义在 `shared/ipc-contract.ts`——renderer 也要用它决定
 * 「文件浏览器入口要不要禁用」，而 renderer 不能 import main。
 */
export type { Capabilities } from '../../shared/ipc-contract';
import type { Capabilities } from '../../shared/ipc-contract';

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
  /**
   * 打开一个交互式会话（终端用）。
   *
   * **异步**：SSH 的 `shell()` 要等一次往返才拿到通道——
   * 同步实现必然拿不到通道，SSH 终端开不起来。
   *
   * pipe 模式的会话不回显（宿主负责），pty 模式的会（远端负责）。
   */
  openSession(opts?: { cols?: number; rows?: number }): Promise<Session>;
}

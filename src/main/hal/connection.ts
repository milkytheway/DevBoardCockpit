import type { Session } from './session';
import type { TransportKind } from '../../shared/ipc-contract';

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
export type { ConnectionCapabilities, FileEntry } from '../../shared/ipc-contract';
import type { ConnectionCapabilities, FileEntry } from '../../shared/ipc-contract';

export interface ExecResult {
  /** null = 拿不到（串口）。超时一律是 124 */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /**
   * **被取消了**（不是超时 ✓ —— 两者不该同码 ✓：
   * 「等久了没结果」与「人主动叫停」是两件事 ✗）。
   *
   * → 尖兵实测：没有这条路时，一个 75 秒的传输步**收到取消后照跑完** ✗。
   */
  cancelled?: boolean;
  /**
   * **给人看的下一步**（可选）。
   *
   * 只在「失败形态容易误判」时给：
   * 串口超时最常见的原因是「**回包被另一个程序吃掉了**」，
   * 而不是「板子慢」——不说清楚，人会往错的方向查。
   *
   * **加字段不改语义**：超时仍然是 `exitCode: 124`（事实 G1）。
   */
  hint?: string;
}

/**
 * 执行一条命令的选项。
 *
 * → **`signal` 是「中途叫停」** ✓（`AbortSignal` ✓）：
 * 超时是「等久了」✓，取消是「**人不要了**」✓ —— 两者分开 ✓。
 */
export interface ExecOptions {
  /** 超时（毫秒） */
  timeoutMs?: number;
  /** 中途叫停（`AbortSignal` ✓） */
  signal?: AbortSignal;
}

export interface Connection {
  readonly id: string;
  readonly transport: TransportKind;
  capabilities(): ConnectionCapabilities;
  open(): Promise<void>;
  close(): Promise<void>;
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  /**
   * 文件互传。
   *
   * **按传输分派**，不是跑远端的 `pull`/`push` 命令——
   * 板子上没有这两个命令（adb 的 pull 是 `adb pull`，ssh 的是 sftp）。
   *
   * ── 语义约定：远端路径一律是「目录」 ──
   *
   * 三种传输的底层工具对「目标」的含义不一样：
   * - `adb push <本地> <目录>` —— 目标是目录，adb 自己补上 basename ✓
   * - `sftp.fastPut(<本地>, <远端文件>)` —— 目标是**完整文件路径**
   * - `copyFile(<本地>, <远端文件>)` —— 目标是**完整文件路径**
   *
   * 所以**统一约定：`remotePath` 是目录**，由各传输自己补 basename。
   * 否则「上传到某个目录」这件事，SSH 与本机必挂
   * （`copyFile(src, '/')` → ENOENT）。
   * （`docs/13-计划1复评报告.md` S-05）
   */
  pull(remotePath: string, localPath: string): Promise<void>;
  push(localPath: string, remotePath: string): Promise<void>;

  /**
   * 列远端目录。
   *
   * **按传输分派**，不是跑一条远端的 `ls`——
   * 本机是 Windows 的 cmd.exe，POSIX 的 `ls -la` 根本不存在（计划 Task 9
   * 写的是「adb 用 `adb shell ls -la`，ssh 用 ssh2 的 `sftp`」）。
   *
   * 目录的 `sizeBytes` 是 `null`（读不到的东西不是 0 —— 事实 G2）。
   */
  list(remotePath: string): Promise<FileEntry[]>;

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

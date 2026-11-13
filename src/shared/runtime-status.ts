import type { ErrorCode } from './errors';

/**
 * tag 运行时的状态。
 *
 * ── 为什么住在 shared ──
 *
 * IPC 通道的类型**住在 `src/shared/`**（依赖方向：main → shared ← renderer）。
 * 而这个状态**要上屏**（面板得说「为什么没有数」）→ 它必须能被 renderer 拿到。
 * 放 `src/main/tags/runtime.ts` 的话，shared 就得依赖 main —— **方向反了**。
 *
 * 所以它搬到这里，`src/main/tags/runtime.ts` 从这儿 import 并**再导出**
 * （既有 import 不断）。
 */

/** 运行时状态机 */
export type RuntimeState = 'idle' | 'running' | 'no-pack' | 'error';

export interface RuntimeStatus {
  state: RuntimeState;
  /** 人话：为什么不是 running */
  detail?: string;
  /** 正在采的是哪个连接 profile */
  profileId?: string;
  /**
   * 失败的**错误码**（`ErrorCode`）。
   *
   * **为什么状态里要带码**：判「串口是不是被别的程序占了」不能靠中文消息匹配
   * ——改一个字就失效。错误码是**封闭的**，`PORT_BUSY` 已经在 `hal/serial.ts` 里用了。
   */
  detailCode?: ErrorCode;
}

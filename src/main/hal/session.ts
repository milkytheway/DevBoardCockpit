import type { SessionLog } from '../logging/session-log';

/**
 * 会话基类与 marker 协议。
 *
 * **marker 协议**是串口的命根子（事实 S1–S3）：
 * 串口只有一根线、一个读线程、一份 transcript，命令靠 marker 认领自己的回包。
 * 板子会**回显**命令，所以同一个 marker 在 transcript 里出现**两次**
 * （回显行一次、输出之后一次）——取「第一次之后的换行」到「第二次出现」之间的内容。
 *
 * marker 格式：`__DBC<pid>_<毫秒时间戳>__`，每次唯一（事实 S3），
 * 且发给用户前必须从 transcript 里抹掉。
 */

/** 全工程统一的超时码（事实 G1）：各传输超时表现不一致，一律归一到 124 */
export const TIMEOUT_EXIT_CODE = 124;

/** 构造本次命令的唯一 marker */
export function buildMarker(pid: number, atMs: number): string {
  return `__DBC${pid}_${atMs}__`;
}

/**
 * 从 transcript 里认领某个 marker 对应的命令输出。
 *
 * - marker 出现两次（板子回显）：取第一次之后到第二次之间的内容
 * - marker 只出现一次（板子不回显）：取第一次之后的全部内容
 * - marker 不存在：返回空串
 *
 * 结果去掉尾部换行。
 */
export function extractMarkerOutput(transcript: string, marker: string): string {
  const first = transcript.indexOf(marker);
  if (first < 0) return '';

  let after = transcript.slice(first + marker.length);
  // 跳过紧跟其后的一个换行（回显行之后就是输出）
  if (after.startsWith('\r\n')) after = after.slice(2);
  else if (after.startsWith('\n')) after = after.slice(1);

  const second = after.indexOf(marker);
  const body = second >= 0 ? after.slice(0, second) : after;

  // 去掉尾部换行
  return body.replace(/\r?\n$/, '');
}

/** 把这些 marker 从文本里抹掉（发给用户前用，事实 S3） */
export function stripMarkers(transcript: string, markers: string[]): string {
  let out = transcript;
  for (const m of markers) {
    out = out.split(m).join('');
  }
  return out;
}

/**
 * 会话基类。
 *
 * 子类实现具体的传输（串口 / ssh / 本地 pty）。
 * 共同的部分是：写日志、退出码语义、marker 管理。
 */
export abstract class Session {
  constructor(protected readonly log: SessionLog) {}

  /** 写数据给远端 */
  abstract write(data: string): void;

  /** 终端尺寸变化。串口没有窗口概念，实现里是空操作 */
  abstract resize(cols: number, rows: number): void;

  /** 关闭会话 */
  abstract close(): void;

  /** 订阅远端输出。传输层把收到的数据喂进来 */
  abstract onData(cb: (chunk: string) => void): void;

  /**
   * 退出码。**串口恒为 null**——串口拿不到 exit status（事实 S5）：
   * 有文本回包算 0，超时算 124。
   */
  abstract readonly exitCode: number | null;

  /** 记录一行到会话日志 */
  protected record(line: string): void {
    this.log.write(line);
  }
}

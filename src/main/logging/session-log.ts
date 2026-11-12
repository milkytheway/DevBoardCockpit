import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 会话日志。
 *
 * 旧工程事实 G4：**崩溃/重启/关窗都不能丢记录**，
 * 每行落盘 + flush、ANSI 码剥掉、路径
 * `%LOCALAPPDATA%/<App>/logs/<date>/<label>-<HHMMSS>.log`。
 *
 * 这里用**同步写**（`appendFileSync`）：每次开合文件本身就是「每行 flush」，
 * 进程被 kill 时已写的行不会丢。异步写要处理背压与 flush 时机，
 * 对一个每秒几行的会话日志来说不值得。
 */

export interface SessionLogOptions {
  /** 进文件名，如 'board-serial' */
  label: string;
  /** 绝对路径，测试传临时目录 */
  dataDir: string;
  /** 注入时钟，默认 () => new Date()。测试用固定时间保证文件名可预测 */
  now?: () => Date;
}

/** 去掉 ANSI 转义序列（颜色、光标移动等） */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/** '<label>-<HHMMSS>.log' */
export function logFileName(label: string, at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const hhmm = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${label}-${hhmm}.log`;
}

export class SessionLog {
  readonly filePath: string;

  constructor(private readonly opts: SessionLogOptions) {
    const at = this.now();
    const dateDir = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
    const dir = join(opts.dataDir, 'logs', dateDir);
    mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, logFileName(opts.label, at));
  }

  /** 写一行：剥 ANSI → 加时间戳前缀 → 追加落盘 */
  write(line: string): void {
    const stamp = this.now().toISOString();
    appendFileSync(this.filePath, `[${stamp}] ${stripAnsi(line)}\n`);
  }

  /** 同步写无需关闭；接口留着，将来换流式写入时用 */
  close(): void {
    /* no-op */
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }
}

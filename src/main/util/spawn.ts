import { spawn } from 'node:child_process';

/**
 * 统一的子进程启动。
 *
 * 三条硬约束：
 *
 * - **事实 G3**：Windows 下 GUI 拉起的进程默认开控制台窗 → 必须 `windowsHide: true`。
 *   否则旧工程那种「每秒采一次指标 → 屏幕狂闪」会重演。
 * - **事实 G1**：超时一律归一到 **124**，调用方只认这一个含义。
 * - **事实 A8**：输出按 UTF-8 解码，坏字节替换成 U+FFFD，**不得废掉整条命令**。
 */

export interface SpawnResult {
  /** null = 被信号杀死或没退出。串口上恒为 null（事实 S5） */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** true 时 exitCode 必为 124 */
  timedOut: boolean;
}

export interface SpawnOptions {
  /** 超时毫秒，默认 30000 */
  timeoutMs?: number;
  /** 写给子进程 stdin 的内容 */
  input?: string;
  /** 追加到 process.env 的环境变量 */
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const TIMEOUT_EXIT_CODE = 124;

export function runProcess(
  command: string,
  args: string[],
  opts: SpawnOptions = {},
): Promise<SpawnResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  return new Promise<SpawnResult>((resolve, reject) => {
    // stdin 用 'pipe' 而不是 'ignore'：需要写 input 时才用得上。
    // 两种情况都会 end 掉 stdin，让子进程看到 EOF 而不是一直等输入。
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.env },
    });

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.on('data', (c: Buffer) => outChunks.push(c));
    child.stderr?.on('data', (c: Buffer) => errChunks.push(c));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? TIMEOUT_EXIT_CODE : code,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });

    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    } else {
      // 不给输入就关掉 stdin，让子进程看到 EOF 而不是一直等
      child.stdin?.end();
    }
  });
}

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
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
 *
 * ── 格式的前身是旧工程 ──
 *
 * `fixtures/session-log/serial-session.log` 这份黄金样本**是旧工程的
 * `SessionLog` 产出的**（`DevBoardConsole/devboard_console/core/session_log.py`）。
 * 所以格式不是猜的，是有出处的：
 *
 * ```
 * [02:15:07.054] === session opened 2026-11-12 02:15:07 target=板子 · 串口 transport=serial ===
 * [02:15:07.054] --- connected 板子 · 串口 ===
 * [02:15:10.071] drwxr-xr-x   3 root root 4.0K Aug 27  2026 data/
 * ...
 * [02:19:47.165] --- disconnected ---
 * [02:19:47.206] --- stream-ended ---
 * === session closed 2026-11-12 02:20:10 ===
 * ```
 *
 * 四条规矩：
 * 1. **每一行都有 `[HH:mm:ss.SSS]` 前缀**（多行 chunk 也要逐行加——
 *    旧工程是 `split("\n")` 后逐行写；不逐行加，第二行就没了前缀）。
 * 2. **会话开/关与事件行**：`=== session opened ... ===`、
 *    `--- connected ... ---`、`=== session closed ... ===`。
 *    注意**收尾那一行没有时间戳**——旧工程是直接写句柄的。
 * 3. **ANSI 全部剥掉**，包括 `ESC[?25l`（隐藏光标）与 OSC 序列。
 * 4. `\r\n` / `\r` 归一成 `\n`——串口控制台的行尾是 CR。
 */

export interface SessionLogOptions {
  /** 进文件名，如 'board-serial' */
  label: string;
  /** 绝对路径，测试传临时目录 */
  dataDir: string;
  /** 传输种类。写进「session opened」那行（旧工程也写） */
  transport?: string;
  /** 注入时钟，默认 () => new Date()。测试用固定时间保证文件名可预测 */
  now?: () => Date;
}

/**
 * 去掉 ANSI 转义序列。
 *
 * **覆盖三种形态**（旧工程 `ANSI_RE` 的口径）：
 * - CSI：`ESC [ <参数> <中间字节> <最终字节>`，参数里可以有 `?`（私有）
 * - OSC：`ESC ] ... BEL`（窗口标题）
 * - 单字符：`ESC <字母>`（例如 `ESC c`）
 *
 * 旧工程的实现只认 `ESC[` + 数字，**漏了 `ESC[?25l`（隐藏光标）与 OSC**——
 * 日志里会留下半截转义码。
 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
  // eslint-disable-next-line no-control-regex
  const OSC = /\x1b\][^\x07]*\x07/g;
  // eslint-disable-next-line no-control-regex
  const CH = /\x1b[@-Z\\-_]/g;
  return s.replace(CSI, '').replace(OSC, '').replace(CH, '');
}

/** 时间戳前缀 `[HH:mm:ss.SSS]`（本地时间） */
export function formatTimestamp(at: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` +
    `.${pad(at.getMilliseconds(), 3)}`
  );
}

/** '<label>-<HHMMSS>.log' */
export function logFileName(label: string, at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const hhmm = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${label}-${hhmm}.log`;
}

/** 文件名里不安全的字符（旧工程 `_SANITIZE` 的口径） */
function safeName(label: string): string {
  const cleaned = label.replace(/[\\/:*?"<>|]+/g, '-').trim().replace(/^-+|-+$/g, '');
  return cleaned || 'session';
}

/** 'YYYY-MM-DD HH:MM:SS'（旧工程事件行里的时间格式） */
function eventStamp(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  );
}

export class SessionLog {
  readonly filePath: string;

  constructor(private readonly opts: SessionLogOptions) {
    const at = this.now();
    const dateDir = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
    const dir = join(opts.dataDir, 'logs', dateDir);
    mkdirSync(dir, { recursive: true });

    // 两个会话在同一秒开起来不许撞名——撞了第二个会**追加**到第一个的日志里，
    // 事后没法分清两段对话。
    //
    // 文件名是 `<label>-<HHMMSS>.log`（`logFileName` 定的口径）。
    // 之前这里写的是 `logFileName('', at).slice(0, 6)`——
    // 那个空 label 会多带一个连字符，切 6 位又**少切一位数字**，
    // 于是 09:05:03 的会话落成 `t--09050.log`。
    const stem = logFileName(safeName(opts.label), at).replace(/\.log$/, '');
    let path = join(dir, `${stem}.log`);
    let counter = 1;
    while (existsSync(path)) {
      path = join(dir, `${stem}-${counter}.log`);
      counter += 1;
    }
    this.filePath = path;

    // 开场行：与旧工程同构（旧工程是在 open() 里写的）
    const transport = opts.transport ?? 'unknown';
    this.write(
      `=== session opened ${eventStamp(at)} target=${opts.label} transport=${transport} ===`,
    );
  }

  /**
   * 写一行：剥 ANSI → **按行拆开** → 每行加时间戳 → 追加落盘。
   *
   * **按行拆开是必须的**：远端一次回包常常是好几行，
   * 不逐行加前缀的话，第二行起就没有时间戳了——
   * 而黄金样本里**每一行都有**。
   */
  write(line: string): void {
    const stamp = formatTimestamp(this.now());
    const text = stripAnsi(line).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (const raw of text.replace(/\n+$/, '').split('\n')) {
      appendFileSync(this.filePath, `[${stamp}] ${raw}\n`);
    }
  }

  /**
   * 记一个事件（连接、断流……）。
   *
   * 旧工程叫 `write_event`，格式是 `--- <kind> [<detail>] ---`。
   */
  writeEvent(kind: string, detail = ''): void {
    this.write(`--- ${kind}${detail ? ` ${detail}` : ''} ---`);
  }

  /**
   * 收尾。
   *
   * **收尾行没有时间戳**——旧工程是直接写句柄的，
   * 黄金样本的最后一行也是这样（`=== session closed ... ===`）。
   */
  close(): void {
    appendFileSync(this.filePath, `=== session closed ${eventStamp(this.now())} ===\n`);
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }
}

/**
 * 管道模式的行编辑。
 *
 * ── 这份代码的规格来源是旧工程 ──
 *
 * `DevBoardConsole/devboard_console/ui/line_editor.py` + `ui/keymap.py` +
 * `ui/console_input.py`（16 KB）就是**这件事的规格**：
 * pipe 模式（`adb shell` 无 PTY）下远端没有 readline，
 * 提示符、回显、行编辑**全都得宿主自己做**。
 *
 * 迁移对照表原来把这一项判成「丢弃 · xterm.js 自带」——**那是错的**
 * （`docs/11-计划1评审报告.md` R-01 已指出；xterm.js 只带 PTY 流，不带行编辑）。
 * 本工程先写了一个最小版本（只做回车与退格），
 * 2026-11-13 拿旧工程的**测试断言**当规格补齐——
 * 旧工程是在真板上跑过的实现，它的测试就是这块行为的标准。
 *
 * 分两层（与旧工程同构）：
 * - `LineEditor`：**纯状态**（文本、光标、历史、kill ring），不碰渲染
 * - `PipeInput`：把**字节流**解成动作 → 改状态 → 渲染回显
 *
 * 为什么按字节而不是按键名：xterm 的 `onData` 给的是**字节**，
 * 方向键是 `ESC [ D` 这样的转义序列——得自己解。
 */

/** 一个按键动作（与旧工程 `keymap.Action` 同义） */
export type EditAction =
  | 'insert'
  | 'backspace'
  | 'delete'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'history_prev'
  | 'history_next'
  | 'kill_word'
  | 'kill_to_start'
  | 'kill_to_end'
  | 'yank'
  | 'commit'
  | 'interrupt'
  | 'clear'
  | 'none';

/**
 * 行编辑状态（纯数据，不含渲染）。
 *
 * 语义**逐条对齐旧工程** `line_editor.py`：
 * 退格删光标前一个字符、Delete 删光标处那个、
 * Ctrl+W 删光标前的词（**连词前的空格一起删**）、
 * Ctrl+U 删光标**之前**的、Ctrl+K 删光标**之后**的、Ctrl+Y 把 kill ring 贴回来。
 */
export class LineEditor {
  text = '';
  cursor = 0;
  /** 已提交过的命令行 */
  history: string[] = [];
  /** null = 正在输入新行；否则是 history 的下标 */
  historyIdx: number | null = null;
  /** kill ring：Ctrl+Y 贴回来的东西 */
  killed = '';

  insert(text: string): void {
    this.text = this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor);
    this.cursor += text.length;
  }

  backspace(): void {
    if (this.cursor > 0) {
      this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
      this.cursor -= 1;
    }
  }

  delete(): void {
    if (this.cursor < this.text.length) {
      this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1);
    }
  }

  moveLeft(): void {
    this.cursor = Math.max(0, this.cursor - 1);
  }

  moveRight(): void {
    this.cursor = Math.min(this.text.length, this.cursor + 1);
  }

  moveHome(): void {
    this.cursor = 0;
  }

  moveEnd(): void {
    this.cursor = this.text.length;
  }

  /**
   * Ctrl+W：删掉光标前那个**词**（连它前面的空格一起）。
   *
   * 旧工程的算法：先往回跳过空格，再往回跳过非空格。
   * 于是 `"cat file.txt"` → `"cat "`（**尾随空格留着**）。
   */
  killWord(): void {
    let start = this.cursor;
    while (start > 0 && /\s/.test(this.text[start - 1])) start -= 1;
    while (start > 0 && !/\s/.test(this.text[start - 1])) start -= 1;
    this.killed = this.text.slice(start, this.cursor);
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
    this.cursor = start;
  }

  /** Ctrl+U：删掉光标**之前**的（后面的留着） */
  killToStart(): void {
    this.killed = this.text.slice(0, this.cursor);
    this.text = this.text.slice(this.cursor);
    this.cursor = 0;
  }

  /** Ctrl+K：删掉光标**之后**的 */
  killToEnd(): void {
    this.killed = this.text.slice(this.cursor);
    this.text = this.text.slice(0, this.cursor);
  }

  /** Ctrl+Y：把 kill ring 贴回来 */
  yank(): void {
    if (this.killed) this.insert(this.killed);
  }

  clear(): void {
    this.text = '';
    this.cursor = 0;
  }

  /** 上箭头：上一条命令 */
  historyPrev(): void {
    if (this.history.length === 0) return;
    if (this.historyIdx === null) this.historyIdx = this.history.length - 1;
    else if (this.historyIdx > 0) this.historyIdx -= 1;
    this.load(this.history[this.historyIdx]);
  }

  /** 下箭头：下一条命令；走过最后一条就清空行 */
  historyNext(): void {
    if (this.historyIdx === null) return;
    if (this.historyIdx < this.history.length - 1) {
      this.historyIdx += 1;
      this.load(this.history[this.historyIdx]);
    } else {
      this.historyIdx = null;
      this.text = '';
      this.cursor = 0;
    }
  }

  /** 收尾：交出这一行，并记住它 */
  commit(): string {
    const line = this.text;
    if (line.trim().length > 0) this.history.push(line);
    this.text = '';
    this.cursor = 0;
    this.historyIdx = null;
    return line;
  }

  private load(value: string): void {
    this.text = value;
    this.cursor = value.length;
  }
}

/**
 * 把字节流解成动作。
 *
 * 转义序列的字节取自旧工程的 `PTY_BYTES`（那里就是终端按键的字节）。
 * 一次 `input` 可能带来多个按键（粘贴），所以是「解出一串动作」。
 */
export function decodeActions(bytes: string): EditAction[] {
  const out: EditAction[] = [];
  let i = 0;
  while (i < bytes.length) {
    const ch = bytes[i];

    // 转义序列
    if (ch === '\x1b') {
      const seq = matchEscape(bytes, i);
      if (seq === null) {
        // 光秃秃的 ESC（或不认识的序列）→ 什么都不做
        i += 1;
        out.push('none');
        continue;
      }
      out.push(seq.action);
      i += seq.length;
      continue;
    }

    switch (ch) {
      case '\r':
      case '\n':
        out.push('commit');
        break;
      case '\x7f':
      case '\x08':
        out.push('backspace');
        break;
      case '\x01':
        out.push('home');
        break;
      case '\x05':
        out.push('end');
        break;
      case '\x0b':
        out.push('kill_to_end');
        break;
      case '\x15':
        out.push('kill_to_start');
        break;
      case '\x17':
        out.push('kill_word');
        break;
      case '\x19':
        out.push('yank');
        break;
      case '\x0c':
        out.push('clear');
        break;
      case '\x03':
        out.push('interrupt');
        break;
      default:
        if (ch < ' ') break; // 其余控制字符丢掉
        out.push('insert');
        break;
    }
    i += 1;
  }
  return out;
}

/** 认出转义序列。返回 null = 不认识（整段丢掉） */
function matchEscape(
  bytes: string,
  at: number,
): { action: EditAction; length: number } | null {
  const rest = bytes.slice(at);
  const table: Array<[string, EditAction]> = [
    ['\x1b[3~', 'delete'],
    ['\x1b[D', 'left'],
    ['\x1b[C', 'right'],
    ['\x1b[A', 'history_prev'],
    ['\x1b[B', 'history_next'],
    ['\x1b[H', 'home'],
    ['\x1b[F', 'end'],
  ];
  for (const [seq, action] of table) {
    if (rest.startsWith(seq)) return { action, length: seq.length };
  }
  // 不认识的 CSI：吃掉到最终字节为止，别把参数当字符插进行里
  // eslint-disable-next-line no-control-regex
  const m = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(rest);
  if (m) return { action: 'none', length: m[0].length };
  return null;
}

/** 提示符的可见宽度（去掉 ANSI 之后的长度） */
export function visibleLength(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').length;
}

/**
 * 显示宽度：**终端的列**，不是字符个数。
 *
 * 一个汉字占 **2 列**，一个 emoji 也占 2 列，组合字符占 0 列。
 * 用 `String.length` 算出来的「UTF-16 码元数」——
 * 重画时按它退列，光标就会越退越偏（中文行一多就歪）。
 *
 * 口径与终端一致（wcwidth 的常见近似）：
 * 东亚宽字符 = 2 列，组合记号 = 0 列，其余 = 1 列。
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (isZeroWidth(cp)) continue;
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

/** 组合记号与零宽字符：占 0 列 */
function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // 组合附加符号
    (cp >= 0x200b && cp <= 0x200f) || // 零宽空格与方向标记
    (cp >= 0xfe00 && cp <= 0xfe0f) || // 变体选择符
    cp === 0xfeff
  );
}

/** 东亚宽字符与 emoji：占 2 列 */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/**
 * pipe 模式的输入层：状态 + 渲染。
 *
 * **渲染策略**：改动之后把整行重画一遍。
 * 逐字符地发退格/擦除在光标不在行尾时会对不齐，
 * 而光标移动、kill、历史调用**都要求行可以重画**。
 */
export class PipeInput {
  readonly editor = new LineEditor();

  /**
   * 「下一个提示符还没画」。
   *
   * ── 为什么提示符要等到用户开始打字才画 ──
   *
   * pipe 模式远端**不发提示符**（没有 tty，`PS1` 无从打印），
   * 所以提示符得宿主画。但**画在提交的那一刻就会排错序**：
   *
   * ```
   * root@board$ ls          ← 命令
   * root@board$             ← 下一个提示符（提交时就画了）
   * file1                    ← 远端的输出（**再走一次往返才回来**）
   * ```
   *
   * 输出落在「下一个提示符」**后面**，读起来像是那个提示符的输出。
   * （`docs/13-计划1复评报告.md` S-04 / `docs/12` N-1）
   *
   * 改成**用户开始打下一条命令时才画**：
   *
   * ```
   * root@board$ ls
   * file1                    ← 输出紧跟在它自己的命令后面
   * root@board$ ls -l        ← 下一个提示符跟着下一条命令一起出现
   * ```
   *
   * 顺序对了，提示符也还在。
   */
  private promptPending = false;

  constructor(private readonly prompt: string = '') {}

  /**
   * 处理一次用户输入。
   *
   * @returns `toRemote` 发给远端的字节；`echo` 回显给用户的内容
   */
  input(bytes: string): { toRemote: string; echo: string } {
    return this.apply(bytes);
  }

  /** 真正干活的地方 */
  private apply(bytes: string): { toRemote: string; echo: string } {
    let toRemote = '';
    let echo = '';
    let dirty = false;
    const before = { text: this.editor.text, cursor: this.editor.cursor };

    // 逐字符处理：普通字符按字符插入，其余按动作
    let i = 0;
    // 上一个字符是 CR —— 紧接着的 LF 是同一个换行的一部分（粘贴时的 CRLF）
    let afterCr = false;
    while (i < bytes.length) {
      const ch = bytes[i];
      if (ch === '\n' && afterCr) {
        afterCr = false;
        i += 1;
        continue;
      }
      afterCr = ch === '\r';
      if (ch === '\x1b') {
        const seq = matchEscape(bytes, i);
        if (seq === null) {
          i += 1;
          continue;
        }
        this.applyAction(seq.action);
        dirty = true;
        i += seq.length;
        continue;
      }

      // 提示符等到「用户开始打字」才画（见 promptPending 的说明）
      if (this.promptPending) {
        echo += this.prompt;
        this.promptPending = false;
      }

      switch (ch) {
        case '\r':
        case '\n':
          // **先把还没画出来的字画出来**再换行——
          // 一次 `input('ls\r')` 里，'ls' 的重画发生在收尾，
          // 不先画出来，这两个字就凭空没了。
          if (dirty) {
            echo += this.redraw(before);
            dirty = false;
          }
          toRemote += `${this.editor.commit()}\n`;
          // **只换行，不画下一个提示符**——提示符要等下一条命令开始才画，
          // 否则远端的输出会落在它的后面。
          echo += '\r\n';
          this.promptPending = true;
          dirty = false;
          before.text = this.editor.text;
          before.cursor = this.editor.cursor;
          break;
        case '\x7f':
        case '\x08':
          this.editor.backspace();
          dirty = true;
          break;
        case '\x01':
          this.editor.moveHome();
          dirty = true;
          break;
        case '\x05':
          this.editor.moveEnd();
          dirty = true;
          break;
        case '\x0b':
          this.editor.killToEnd();
          dirty = true;
          break;
        case '\x15':
          this.editor.killToStart();
          dirty = true;
          break;
        case '\x17':
          this.editor.killWord();
          dirty = true;
          break;
        case '\x19':
          this.editor.yank();
          dirty = true;
          break;
        case '\x0c':
          // 清**屏**（旧工程 keymap 的规格：Clear the screen → clear_requested → 清屏），
          // 不是清这一行。行还在，只是屏幕被清空、提示符重画。
          echo += '\x1b[2J\x1b[H';
          this.editor.clear();
          echo += this.prompt;
          dirty = false;
          break;
        case '\x03':
          // 中断：字节发给远端（管道里没有信号，只能发字节）
          toRemote += '\x03';
          // **这一行要丢掉**——不然下次回车会把「旧命令 + 新命令」拼成一条发出去
          this.editor.clear();
          echo += '^C\r\n';
          this.promptPending = true;
          dirty = false;
          break;
        default:
          if (ch >= ' ') {
            this.editor.insert(ch);
            dirty = true;
          }
          break;
      }
      i += 1;
    }

    if (dirty) {
      echo += this.redraw(before);
    }
    return { toRemote, echo };
  }

  private applyAction(action: EditAction): void {
    switch (action) {
      case 'delete':
        this.editor.delete();
        break;
      case 'left':
        this.editor.moveLeft();
        break;
      case 'right':
        this.editor.moveRight();
        break;
      case 'home':
        this.editor.moveHome();
        break;
      case 'end':
        this.editor.moveEnd();
        break;
      case 'history_prev':
        this.editor.historyPrev();
        break;
      case 'history_next':
        this.editor.historyNext();
        break;
      default:
        break;
    }
  }

  /**
   * 把整行重画一遍。
   *
   * 步骤：回到行首 → 擦到行尾 → 写新文本 → 把光标挪到该在的位置。
   * 「行首」= 提示符之后，所以要退 `提示符宽度 + 旧光标` 列。
   */
  private redraw(before: { text: string; cursor: number }): string {
    // **只退到文本区起点**，不能退到提示符之前——
    // 退过头再擦行（ESC[K），就把提示符本身擦掉了，
    // 而提示符是 pipe 模式唯一的「我在这儿」信号。
    //
    // 列数按**显示宽度**算：汉字占两列，用字符数会越退越偏。
    const back = displayWidth(before.text.slice(0, before.cursor));
    let out = '';
    if (back > 0) out += `\x1b[${back}D`;
    out += '\x1b[K';
    out += this.editor.text;
    const tail = displayWidth(this.editor.text.slice(this.editor.cursor));
    if (tail > 0) out += `\x1b[${tail}D`;
    return out;
  }
}

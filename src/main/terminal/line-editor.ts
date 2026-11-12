/**
 * 管道模式的行规程。
 *
 * **为什么需要它**：pipe 模式（`adb shell` 不带 `-t`）下，
 * 远端**没有行规程**——它既不认回车，也不做退格。
 * xterm 在回车键上发的是 `'\r'`，而 busybox 的 shell 只认 `'\n'`。
 * 于是 `'\r'` 被原样塞进管道，**shell 永远等不到行尾**：
 * 用户看着自己打的字（宿主在回显），按回车什么也不发生，输入越积越长。
 *
 * 这条是真机实测出来的（`docs/11-计划1评审报告.md` R-01）：
 *
 * ```
 * sent: "sleep 2; echo DONE_MARKER\r"   →  3.5 秒后输出 = ""
 * 补发 LF 后                            →  输出 = "DONE_MARKER\r\n"
 * ```
 *
 * **pty 模式不需要它**：远端有真终端（getty / sshd），行规程在那边。
 * 所以这个类只给 pipe 模式用（现在只有 ADB）。
 *
 * **前身工程有这套东西**（`ui/line_editor.py` + `keymap.py`），
 * 迁移时被当成「xterm.js 自带」丢掉了——那个判断是错的：
 * xterm.js 只带 PTY 流，不带行编辑。
 *
 * ── 关键设计：整行缓存在本地 ──
 *
 * 逐字符转发给远端是**不行**的：管道里没有行规程，
 * 已经发出去的字节**收不回来**——用户按退格，远端那边仍然留着那个字符。
 * （真终端能退格，靠的是**主机侧**的行规程把整行缓冲在主机上。）
 *
 * 所以这里做「主机侧行规程」该做的事：
 * 字符先进本地缓冲并回显；**按回车时，才把整行连同 `\n` 发给远端**。
 * 这样退格改的是「还没发出去的行」，退得掉。
 */
export interface LineEdit {
  /** 要发给远端的字节。**只在回车时才有内容**（整行 + `\n`） */
  toRemote: string;
  /** 要回显给用户的文本。pipe 模式远端不回显，所以宿主自己回显 */
  echo: string;
}

const BACKSPACE = '\x7f'; // DEL —— 终端的退格键发的是它
const BS = '\x08'; // BS —— 有些终端发这个
const CTRL_C = '\x03';
const CTRL_U = '\x15'; // 删整行
const CTRL_W = '\x17'; // 删前一个词
const ESC = '\x1b';

export class PipeLineEditor {
  /** 当前行已输入的内容（用户看得见的那一行） */
  private line = '';

  /** 当前行光标位置（字符下标） */
  private cursor = 0;

  /** 正在吞一个转义序列（方向键等） */
  private escapeState: 'none' | 'afterEsc' | 'inSeq' = 'none';

  /** 上一个字符是 CR —— 紧接着的 LF 是同一个换行的一部分 */
  private afterCr = false;

  /**
   * 处理一次用户输入。
   *
   * xterm 一次 onData 通常是一个按键，但也可能是一整段粘贴，
   * 所以按字符逐个处理。
   */
  input(data: string): LineEdit {
    let toRemote = '';
    let echo = '';

    for (const ch of data) {
      // 吞掉整个转义序列：ESC [ A（方向键）、ESC O A（功能键）……
      if (this.escapeState === 'afterEsc') {
        // '[' 是 CSI 的引入符，'O' 是 SS3 —— 它们后面还有最终字节
        this.escapeState = ch === '[' || ch === 'O' ? 'inSeq' : 'none';
        continue;
      }
      if (this.escapeState === 'inSeq') {
        // CSI 的最终字节落在 0x40–0x7E
        if (ch >= '\x40' && ch <= '\x7e') this.escapeState = 'none';
        continue;
      }
      if (ch === ESC) {
        this.escapeState = 'afterEsc';
        continue;
      }

      // CRLF 是一次换行，不是两次
      if (ch === '\n' && this.afterCr) {
        this.afterCr = false;
        continue;
      }
      this.afterCr = ch === '\r';

      switch (ch) {
        case '\r':
        case '\n': {
          // 回车 → 整行发给远端，行尾是 `\n`（远端只认 LF）。
          // 回显是 `\r\n`，让用户看到自己换行了。
          toRemote += `${this.line}\n`;
          echo += '\r\n';
          this.line = '';
          this.cursor = 0;
          break;
        }
        case BACKSPACE:
        case BS: {
          if (this.cursor === 0) break;
          // 退格：删掉光标前一个字符，并把光标退回去
          this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor);
          this.cursor -= 1;
          // 回显「退格 + 空格 + 退格」——终端据此把光标退一格并擦掉那个字符
          echo += '\b \b';
          break;
        }
        case CTRL_C: {
          // 中断：管道里没有信号，只能发字节过去；
          // 本地清行并显示 ^C。
          toRemote += CTRL_C;
          echo += '^C\r\n';
          this.line = '';
          this.cursor = 0;
          break;
        }
        case CTRL_U: {
          // 删整行
          echo += '\b \b'.repeat(this.cursor);
          this.line = '';
          this.cursor = 0;
          break;
        }
        case CTRL_W: {
          // 删前一个词
          const head = this.line.slice(0, this.cursor);
          const trimmed = head.replace(/\S*\s*$/, '');
          const removed = head.length - trimmed.length;
          if (removed === 0) break;
          this.line = trimmed + this.line.slice(this.cursor);
          this.cursor = trimmed.length;
          echo += '\b \b'.repeat(removed);
          break;
        }
        default: {
          if (ch < ' ') break; // 其余控制字符丢掉
          this.line = this.line.slice(0, this.cursor) + ch + this.line.slice(this.cursor);
          this.cursor += 1;
          echo += ch;
          break;
        }
      }
    }

    return { toRemote, echo };
  }

  /** 当前行内容。给测试看，也给将来做历史用 */
  get currentLine(): string {
    return this.line;
  }
}

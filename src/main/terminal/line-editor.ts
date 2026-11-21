/**
 * The line editing of pipe mode.
 *
 * ── The specification of this code is the legacy project ──
 *
 * `DevBoardConsole/devboard_console/ui/line_editor.py` + `ui/keymap.py` +
 * `ui/console_input.py` (16 KB) is the specification of this very thing:
 * in pipe mode (`adb shell` without a PTY) the remote side has no readline,
 * so the prompt, the echo and the line editing all have to be done by the
 * host.
 *
 * The migration comparison table used to judge this item as "drop it,
 * xterm.js has it built in" — that was wrong (the plan-1 review, finding
 * R-01, already pointed it out; xterm.js only carries the PTY stream, not
 * the line editing). This project first wrote a minimal version (only
 * carriage return and backspace), and on 2026-11-13 the test assertions of
 * the legacy project were taken as the specification to complete it — the
 * legacy project is an implementation that was run on a real board, so its
 * tests are the standard for this behaviour.
 *
 * Two layers (isomorphic with the legacy project):
 * - `LineEditor`: pure state (text, cursor, history, kill ring), it does not
 *   touch the rendering
 * - `PipeInput`: decodes the byte stream into actions → changes the state →
 *   renders the echo
 *
 * Why by bytes and not by key names: the `onData` of xterm hands over bytes,
 * and the arrow keys are escape sequences like `ESC [ D` — they have to be
 * decoded by hand.
 */

/** One keystroke action (the same as the `keymap.Action` of the legacy project) */
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
 * The line editing state (pure data, no rendering).
 *
 * The semantics line up with the legacy project `line_editor.py` one by one:
 * backspace deletes the character before the cursor, Delete deletes the one
 * under the cursor, Ctrl+W deletes the word before the cursor (together with
 * the space in front of it), Ctrl+U deletes what is before the cursor,
 * Ctrl+K what is after it, Ctrl+Y puts the kill ring back.
 */
export class LineEditor {
  text = '';
  cursor = 0;
  /** The command lines that have been submitted */
  history: string[] = [];
  /** null = a new line is being typed; otherwise the index into history */
  historyIdx: number | null = null;
  /** kill ring: the thing Ctrl+Y puts back */
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
   * Ctrl+W: deletes the word before the cursor (together with the space in
   * front of it).
   *
   * The algorithm of the legacy project: skip the spaces backwards first,
   * then skip the non-spaces backwards. So `"cat file.txt"` → `"cat "` (the
   * trailing space stays).
   */
  killWord(): void {
    let start = this.cursor;
    while (start > 0 && /\s/.test(this.text[start - 1])) start -= 1;
    while (start > 0 && !/\s/.test(this.text[start - 1])) start -= 1;
    this.killed = this.text.slice(start, this.cursor);
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
    this.cursor = start;
  }

  /** Ctrl+U: deletes what is before the cursor (what is after it stays) */
  killToStart(): void {
    this.killed = this.text.slice(0, this.cursor);
    this.text = this.text.slice(this.cursor);
    this.cursor = 0;
  }

  /** Ctrl+K: deletes what is after the cursor */
  killToEnd(): void {
    this.killed = this.text.slice(this.cursor);
    this.text = this.text.slice(0, this.cursor);
  }

  /** Ctrl+Y: puts the kill ring back */
  yank(): void {
    if (this.killed) this.insert(this.killed);
  }

  clear(): void {
    this.text = '';
    this.cursor = 0;
  }

  /** The up arrow: the previous command */
  historyPrev(): void {
    if (this.history.length === 0) return;
    if (this.historyIdx === null) this.historyIdx = this.history.length - 1;
    else if (this.historyIdx > 0) this.historyIdx -= 1;
    this.load(this.history[this.historyIdx]);
  }

  /** The down arrow: the next command; past the last one the line is cleared */
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

  /** Wrapping up: hands out this line and remembers it */
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
 * Decodes a byte stream into actions.
 *
 * The bytes of the escape sequences come from the `PTY_BYTES` of the legacy
 * project (there they are the bytes of the terminal keys). One `input` can
 * bring several keystrokes (a paste), so it decodes into a string of
 * actions.
 */
export function decodeActions(bytes: string): EditAction[] {
  const out: EditAction[] = [];
  let i = 0;
  while (i < bytes.length) {
    const ch = bytes[i];

    // An escape sequence
    if (ch === '\x1b') {
      const seq = matchEscape(bytes, i);
      if (seq === null) {
        // A bare ESC (or an unknown sequence) → do nothing
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
        if (ch < ' ') break; // The remaining control characters are dropped
        out.push('insert');
        break;
    }
    i += 1;
  }
  return out;
}

/** Recognises an escape sequence. Returning null = unknown (the whole thing is dropped) */
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
  // An unknown CSI: eat it up to the final byte, do not insert its
  // parameters into the line as characters
  // eslint-disable-next-line no-control-regex
  const m = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(rest);
  if (m) return { action: 'none', length: m[0].length };
  return null;
}

/** The visible width of the prompt (the length after the ANSI has been removed) */
export function visibleLength(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').length;
}

/**
 * The display width: the columns of the terminal, not the number of
 * characters.
 *
 * One Chinese character takes 2 columns, one emoji also takes 2 columns, a
 * combining character takes 0 columns. The "number of UTF-16 code units"
 * that `String.length` gives — when the line is redrawn and the cursor is
 * moved back by that much, it drifts more and more (the more Chinese lines,
 * the more it skews).
 *
 * The measure is the same as the terminal's (the common approximation of
 * wcwidth): East Asian wide characters = 2 columns, combining marks = 0
 * columns, everything else = 1 column.
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

/** Combining marks and zero-width characters: 0 columns */
function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // Combining marks
    (cp >= 0x200b && cp <= 0x200f) || // Zero-width spaces and directional marks
    (cp >= 0xfe00 && cp <= 0xfe0f) || // Variation selectors
    cp === 0xfeff
  );
}

/** East Asian wide characters and emoji: 2 columns */
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
 * The input layer of pipe mode: state + rendering.
 *
 * The rendering strategy: after a change, redraw the whole line. Sending
 * backspaces and erasures character by character misaligns when the cursor
 * is not at the end of the line, and cursor movement, kill and history all
 * require that the line can be redrawn.
 */
export class PipeInput {
  readonly editor = new LineEditor();
  private readonly prompt: string;

  /**
   * "The next prompt has not been drawn yet".
   *
   * ── Why the prompt waits until the user starts typing ──
   *
   * In pipe mode the remote side sends no prompt (there is no tty, so
   * `PS1` cannot be printed), so the host has to draw the prompt. But
   * drawing it at the moment of the commit puts the order wrong:
   *
   * ```
   * root@board$ ls          ← the command
   * root@board$             ← the next prompt (drawn at the commit)
   * file1                    ← the output of the remote side (it takes
   *                            another round trip to come back)
   * ```
   *
   * The output lands after the "next prompt" and reads as if it were the
   * output of that prompt. (Plan-1 re-review, finding S-04 / finding N-1 of
   * the plan-1 documents)
   *
   * It was changed to: it is drawn when the user starts typing the next
   * command.
   *
   * ```
   * root@board$ ls
   * file1                    ← the output follows right after its own command
   * root@board$ ls -l        ← the next prompt appears together with the next
   *                            command
   * ```
   *
   * The order is right and the prompt is still there.
   */
  private promptPending: boolean;

  constructor(prompt: string = '') {
    this.prompt = prompt.trim().length > 0 ? renderPipePrompt(prompt) : '';
    this.promptPending = this.prompt.length > 0;
  }

  /** The first prompt shown when the terminal becomes visible. */
  initialPrompt(): string {
    this.promptPending = false;
    return this.prompt;
  }

  /** Whether the prompt should be drawn once the remote output becomes quiet. */
  get waitingForPrompt(): boolean {
    return this.promptPending;
  }

  /** Draw the pending prompt once remote output has gone quiet. */
  promptWhenIdle(): string {
    if (!this.promptPending) return '';
    this.promptPending = false;
    return this.prompt;
  }

  /**
   * Handles one piece of user input.
   *
   * @returns `toRemote` the bytes to send to the remote side; `echo` the
   *   content echoed back to the user
   */
  input(bytes: string): { toRemote: string; echo: string } {
    return this.apply(bytes);
  }

  /** Where the real work happens */
  private apply(bytes: string): { toRemote: string; echo: string } {
    let toRemote = '';
    let echo = '';
    let dirty = false;
    const before = { text: this.editor.text, cursor: this.editor.cursor };

    // Character by character: an ordinary character is inserted as a character, the rest as an action
    let i = 0;
    // The previous character was a CR — the LF right after it belongs to the same newline (the CRLF of a paste)
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

      // The prompt waits until "the user starts typing" (see the explanation of promptPending)
      if (this.promptPending) {
        echo += this.prompt;
        this.promptPending = false;
      }

      switch (ch) {
        case '\r':
        case '\n':
          // The characters that have not been drawn yet are drawn first, and
          // then the newline — in one `input('ls\r')` the redraw of 'ls'
          // happens at the end, and without drawing it first those two
          // characters vanish into thin air.
          if (dirty) {
            echo += this.redraw(before);
            dirty = false;
          }
          toRemote += `${this.editor.commit()}\n`;
          // Only the newline, no next prompt — the prompt is drawn when the
          // next command starts, otherwise the output of the remote side
          // lands after it.
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
          // It clears the screen (the specification of the keymap of the
          // legacy project: Clear the screen → clear_requested → clear the
          // screen), not this line. The line is still there, only the screen
          // was cleared and the prompt is drawn again.
          echo += '\x1b[2J\x1b[H';
          this.editor.clear();
          echo += this.prompt;
          dirty = false;
          break;
        case '\x03':
          // Interrupt: the bytes go to the remote side (there is no signal in a pipe, only bytes)
          toRemote += '\x03';
          // This line has to be dropped — otherwise the next carriage return sends "old command + new command" as one line
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
   * Redraws the whole line.
   *
   * The steps: back to the start of the line → erase to the end of the line
   * → write the new text → move the cursor to where it belongs. The "start
   * of the line" = after the prompt, so the cursor moves back
   * `prompt width + old cursor` columns.
   */
  private redraw(before: { text: string; cursor: number }): string {
    // It only moves back to the start of the text area, it must not move
    // back in front of the prompt — moving back too far and then erasing the
    // line (ESC[K) erases the prompt itself, and the prompt is the only
    // "I am here" signal of pipe mode.
    //
    // The number of columns is computed by the display width: a Chinese
    // character takes two columns, and counting characters drifts more and
    // more.
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

/**
 * A complete, coloured prompt for pipe-mode terminals.
 *
 * The profile may only carry `root@ATK-DLRK3588`; without a separator the
 * first typed character looks like part of the hostname. The prompt is rendered
 * by the host in ADB pipe mode, so this is also the one place that gives it a
 * stable terminal colour.
 */
export function renderPipePrompt(raw: string): string {
  const base = raw.trimEnd();
  if (base.length === 0) return '';
  const ansiSgr = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  const plain = base.replace(ansiSgr, '');
  const complete = /[$#>]$/.test(plain) ? plain : `${plain} $`;
  return `\x1b[1;36m${complete}\x1b[0m `;
}

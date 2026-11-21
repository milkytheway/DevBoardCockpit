import { describe, it, expect } from 'vitest';
import { PipeInput, LineEditor, decodeActions, displayWidth } from '../../src/main/terminal/line-editor';

/**
 * The line editor of the pipe mode.
 *
 * The cases below marked as the specification of the old project were
 * **ported one by one** from
 * `DevBoardConsole/tests/test_console_input.py` and `test_keymap.py`, the
 * tests of an implementation that the old project **ran on a real board**;
 * they are the standard for the behaviour "the pipe mode has to do its own
 * line editing". The rest was added by this project (the protocol of the
 * sending side).
 *
 * Why this exists: in the pipe mode the remote side has **no line
 * discipline** — the `'\r'` is sent as it is and the shell of busybox never
 * sees the end of a line. That was measured on a real board.
 */

/** Types a piece of text (character by character, like the real keys) */
function type(input: PipeInput, text: string): { toRemote: string; echo: string } {
  let toRemote = '';
  let echo = '';
  for (const ch of text) {
    const r = input.input(ch);
    toRemote += r.toRemote;
    echo += r.echo;
  }
  return { toRemote, echo };
}

function plain(text: string): string {
  return text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g'), '');
}

describe('the state of the line editor (the specification of the old project)', () => {
  it('the inserted character stays in the line and the cursor follows', () => {
    const ed = new LineEditor();
    ed.insert('ls -la');
    expect(ed.text).toBe('ls -la');
    expect(ed.cursor).toBe(6);
  });

  it('the cursor can move inside the line and the insertion lands at the cursor', () => {
    // The specification of the old project: "ls -la" moves back one column and
// inserts X → "ls -lXa"
    const ed = new LineEditor();
    ed.insert('ls -la');
    ed.moveLeft();
    ed.insert('X');
    expect(ed.text).toBe('ls -lXa');
    expect(ed.cursor).toBe(6);
  });

  it('backspace removes the character in front of the cursor', () => {
    // The specification of the old project: "abc" moves back one column and
// backspaces → "ac"
    const ed = new LineEditor();
    ed.insert('abc');
    ed.moveLeft();
    ed.backspace();
    expect(ed.text).toBe('ac');
  });

  it('Delete removes the character at the cursor', () => {
    // The specification of the old project: "abc" goes to the start of the line
// and then Delete → "bc"
    const ed = new LineEditor();
    ed.insert('abc');
    ed.moveHome();
    ed.delete();
    expect(ed.text).toBe('bc');
  });

  it('the history can be recalled', () => {
    // The specification of the old project: submit first, second, the up arrow
// reaches second first and then first
    const ed = new LineEditor();
    ed.insert('first');
    ed.commit();
    ed.insert('second');
    ed.commit();
    ed.historyPrev();
    expect(ed.text).toBe('second');
    ed.historyPrev();
    expect(ed.text).toBe('first');
    ed.historyNext();
    expect(ed.text).toBe('second');
  });

  it('going past the end of the history clears the line', () => {
    // The specification of the old project
    const ed = new LineEditor();
    ed.insert('first');
    ed.commit();
    ed.historyPrev();
    ed.historyNext();
    expect(ed.text).toBe('');
  });

  it('Ctrl+W removes one word', () => {
    // The specification of the old project: "cat file.txt" → "cat " (the space in
// front of the word goes with it)
    const ed = new LineEditor();
    ed.insert('cat file.txt');
    ed.killWord();
    expect(ed.text).toBe('cat ');
  });

  it('Ctrl+U removes what is in front of the cursor (what is behind stays)', () => {
    // The specification of the old project: "prefix command" with the cursor after
// the second character → "efix command"
    const ed = new LineEditor();
    ed.insert('prefix command');
    ed.moveHome();
    ed.moveRight();
    ed.moveRight();
    ed.killToStart();
    expect(ed.text).toBe('efix command');
  });

  it('the kill ring can be pasted back', () => {
    // The specification of the old project
    const ed = new LineEditor();
    ed.insert('word');
    ed.killWord();
    expect(ed.text).toBe('');
    ed.yank();
    expect(ed.text).toBe('word');
  });
});

describe('the decoding of a byte stream into actions', () => {
  it('it recognises the bytes of the terminal keys', () => {
    expect(decodeActions('\r')).toEqual(['commit']);
    expect(decodeActions('\x7f')).toEqual(['backspace']);
    expect(decodeActions('\x1b[D')).toEqual(['left']);
    expect(decodeActions('\x1b[C')).toEqual(['right']);
    expect(decodeActions('\x1b[3~')).toEqual(['delete']);
    expect(decodeActions('\x1b[A')).toEqual(['history_prev']);
    expect(decodeActions('\x1b[B')).toEqual(['history_next']);
    expect(decodeActions('\x01')).toEqual(['home']);
    expect(decodeActions('\x05')).toEqual(['end']);
    expect(decodeActions('\x17')).toEqual(['kill_word']);
    expect(decodeActions('\x15')).toEqual(['kill_to_start']);
    expect(decodeActions('\x0b')).toEqual(['kill_to_end']);
    expect(decodeActions('\x19')).toEqual(['yank']);
    expect(decodeActions('\x03')).toEqual(['interrupt']);
  });

  it('an escape sequence such as an arrow key is not inserted into the line as characters', () => {
    expect(decodeActions('\x1b[A')).not.toContain('insert');
  });
});

describe('the protocol of the pipe mode towards the remote side', () => {
  it('the return key sends the whole line with the LF to the remote side — the remote shell only accepts LF', () => {
    // This case corresponds to the measurement on a real board:
    // in the pipe mode the '\r' is sent as it is and the shell of busybox never
// sees the end of a line.
    const input = new PipeInput();
    type(input, 'ls');
    const r = input.input('\r');
    expect(r.toRemote).toBe('ls\n');
  });

  it('while typing nothing is sent to the remote side (the whole line is buffered locally, and only then can the backspace take something back)', () => {
    const input = new PipeInput();
    const r = type(input, 'ls');
    // The remote side received nothing — there is no line discipline in a pipe, and
// what was sent cannot be taken back
    expect(r.toRemote).toBe('');
  });

  it('the backspace really removes it from the line that was sent', () => {
    const input = new PipeInput();
    type(input, 'ls');
    input.input('\x7f');
    expect(input.input('\r').toRemote).toBe('l\n');
  });

  it('the prompt is drawn only when the next command begins — the output is not pushed behind the next prompt', () => {
    // If the next prompt were drawn at the moment of the submission, the output of
// the remote side (**which needs another round trip**)
    // would land **behind** that prompt and read as its output.
    const input = new PipeInput('root@board$ ');
    type(input, 'ls');
    const r = input.input('\r');
    // The submission only moves to the next line
    expect(r.echo).toBe('\r\n');
    expect(r.toRemote).toBe('ls\n');

    // The operator starts to type the next command, the prompt comes with it
    const r2 = input.input('x');
    expect(plain(r2.echo).startsWith('root@board$ ')).toBe(true);
    expect(plain(r2.echo)).toContain('x');
  });

  it('Ctrl+C interrupts the remote side and clears the line', () => {
    const input = new PipeInput();
    type(input, 'sleep 100');
    const r = input.input('\x03');
    expect(r.toRemote).toBe('\x03');
    expect(r.echo).toContain('^C');
  });

  it('pasting a piece of multi-line text: every line ends with an LF', () => {
    const input = new PipeInput();
    const r = input.input('a\r\nb\r\n');
    expect(r.toRemote).toBe('a\nb\n');
  });

  it('the cursor moves into the middle of the line and the insertion lands at the cursor', () => {
    const input = new PipeInput();
    type(input, 'ls -la');
    input.input('\x1b[D'); // One column to the left
    const r = input.input('X');
    expect(input.editor.text).toBe('ls -lXa');
    expect(input.editor.cursor).toBe(6);
    // The redraw uses an ANSI cursor movement and the erase of the line
    expect(r.echo).toContain('\x1b[');
  });

  it('the history: the up arrow recalls the previous command', () => {
    const input = new PipeInput();
    type(input, 'first');
    input.input('\r');
    type(input, 'second');
    input.input('\r');
    input.input('\x1b[A'); // The up arrow
    expect(input.editor.text).toBe('second');
    expect(input.input('\r').toRemote).toBe('second\n');
  });

  it('Ctrl+W removes one word (with the space in front of it)', () => {
    const input = new PipeInput();
    type(input, 'cat file.txt');
    input.input('\x17');
    expect(input.editor.text).toBe('cat ');
  });
});

describe('the cases added by the third audit', () => {
  it('the redraw may not go past the prompt — a prompt that was erased is no prompt', () => {
    // The prompt and the input are on the same line, so the redraw may only go
// back to the **start of the text area**,
    // going back too far (in front of the prompt) and erasing the line would erase
// the prompt itself.
    const input = new PipeInput('root@ATK-DLRK3588');
    const r = input.input('l');
    // The first character: the cursor is at the start of the text area, not a
// single column has to be taken back
    expect(r.echo).not.toContain('\x1b[17D');
    expect(r.echo).not.toContain('\x1b[15D');
    // The second character: one column (one character) is taken back, not the whole
// way to the start of the line
    const r2 = input.input('s');
    expect(r2.echo).toContain('\x1b[1D');
    expect(r2.echo).not.toContain('\x1b[16D');
  });

  it('Ctrl+C has to clear the line — the name of the case promises a "clear line"', () => {
    const input = new PipeInput();
    input.input('sleep 100');
    input.input('\x03');
    expect(input.editor.text).toBe('');
    // After the line was cleared and typed again, the return key sends the new
// command, not two pieces joined together
    input.input('ls');
    expect(input.input('\r').toRemote).toBe('ls\n');
  });

  it('Ctrl+L clears the screen (the specification of the keymap of the old project: Clear the screen)', () => {
    const input = new PipeInput();
    input.input('ls');
    const r = input.input('\x0c');
    // Clear the screen + move the cursor home + draw the prompt again
    expect(r.echo).toContain('\x1b[2J');
    expect(r.echo).toContain('\x1b[H');
  });

  it('the column is counted by the display width — one Chinese character takes two columns', () => {
    expect(displayWidth('中')).toBe(2);
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('中文abc')).toBe(7);

    const input = new PipeInput();
    input.input('中'); // One Chinese character = two columns
    const r = input.input('文');
    // Two columns are taken back (the display width), not one (the length in
// UTF-16)
    expect(r.echo).toContain('\x1b[2D');
  });
});

describe('the pipe prompt of ADB', () => {
  it('is coloured, has a separating space and stays on the same line as the typed command', () => {
    const input = new PipeInput('root@ATK-DLRK3588');
    const r = input.input('pwd');
    expect(r.echo).toContain('\x1b[');
    expect(plain(r.echo)).toContain('root@ATK-DLRK3588 $ pwd');
    expect(r.echo).not.toContain('\n');
  });
});

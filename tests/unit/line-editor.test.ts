import { describe, it, expect } from 'vitest';
import { PipeInput, LineEditor, decodeActions, displayWidth } from '../../src/main/terminal/line-editor';

/**
 * 管道模式的行编辑。
 *
 * ── 这组用例的规格来源是旧工程 ──
 *
 * `DevBoardConsole/tests/test_console_input.py` 与 `test_keymap.py`
 * 是**旧工程在真板上跑过的实现**的测试——
 * 它们就是「pipe 模式要自己做行编辑」这块行为的标准。
 *
 * 下面标了「旧工程规格」的几条，是**逐条移植**过来的断言；
 * 其余是本工程自己加的（发送侧的协议）。
 *
 * 为什么要有这块东西：pipe 模式下远端**没有行规程**——
 * `'\r'` 原样发过去，busybox 的 shell 永远等不到行尾
 * （`docs/11-计划1评审报告.md` R-01 的真机实测）。
 */

/** 敲一段文字（逐字符送进去，与真实按键一致） */
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

describe('行编辑状态（旧工程规格）', () => {
  it('插入的字符留在行里，光标跟着走', () => {
    const ed = new LineEditor();
    ed.insert('ls -la');
    expect(ed.text).toBe('ls -la');
    expect(ed.cursor).toBe(6);
  });

  it('光标能在行里移动，插入落在光标处', () => {
    // 旧工程规格："ls -la" 退一格再插 X → "ls -lXa"
    const ed = new LineEditor();
    ed.insert('ls -la');
    ed.moveLeft();
    ed.insert('X');
    expect(ed.text).toBe('ls -lXa');
    expect(ed.cursor).toBe(6);
  });

  it('退格删掉光标前那个字符', () => {
    // 旧工程规格："abc" 退一格再退格 → "ac"
    const ed = new LineEditor();
    ed.insert('abc');
    ed.moveLeft();
    ed.backspace();
    expect(ed.text).toBe('ac');
  });

  it('Delete 删掉光标处那个字符', () => {
    // 旧工程规格："abc" 回到行首再 Delete → "bc"
    const ed = new LineEditor();
    ed.insert('abc');
    ed.moveHome();
    ed.delete();
    expect(ed.text).toBe('bc');
  });

  it('历史能回来', () => {
    // 旧工程规格：提交 first、second，上键先到 second 再到 first
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

  it('走过历史末尾就清空行', () => {
    // 旧工程规格
    const ed = new LineEditor();
    ed.insert('first');
    ed.commit();
    ed.historyPrev();
    ed.historyNext();
    expect(ed.text).toBe('');
  });

  it('Ctrl+W 删掉一个词', () => {
    // 旧工程规格："cat file.txt" → "cat "（词前的空格一起删）
    const ed = new LineEditor();
    ed.insert('cat file.txt');
    ed.killWord();
    expect(ed.text).toBe('cat ');
  });

  it('Ctrl+U 删掉光标之前的（后面的留着）', () => {
    // 旧工程规格："prefix command" 光标在第 2 个字符后 → "efix command"
    const ed = new LineEditor();
    ed.insert('prefix command');
    ed.moveHome();
    ed.moveRight();
    ed.moveRight();
    ed.killToStart();
    expect(ed.text).toBe('efix command');
  });

  it('kill ring 能贴回来', () => {
    // 旧工程规格
    const ed = new LineEditor();
    ed.insert('word');
    ed.killWord();
    expect(ed.text).toBe('');
    ed.yank();
    expect(ed.text).toBe('word');
  });
});

describe('字节流解成动作', () => {
  it('认出终端按键的字节', () => {
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

  it('方向键这类转义序列不会被当成字符插进行里', () => {
    expect(decodeActions('\x1b[A')).not.toContain('insert');
  });
});

describe('pipe 模式发往远端的协议', () => {
  it('回车把整行连同 LF 发给远端 —— 远端 shell 只认 LF', () => {
    // 这条对应 docs/11 R-01 的真机实测：
    // pipe 模式下 '\r' 原样发过去，busybox 的 shell 永远等不到行尾。
    const input = new PipeInput();
    type(input, 'ls');
    const r = input.input('\r');
    expect(r.toRemote).toBe('ls\n');
  });

  it('打字过程中不发给远端（整行缓存在本地，退格才退得掉）', () => {
    const input = new PipeInput();
    const r = type(input, 'ls');
    // 远端什么都没收到 —— 管道里没有行规程，发出去的字收不回来
    expect(r.toRemote).toBe('');
  });

  it('退格真的从发出去的那行里消失', () => {
    const input = new PipeInput();
    type(input, 'ls');
    input.input('\x7f');
    expect(input.input('\r').toRemote).toBe('l\n');
  });

  it('提示符在换行后画下一个', () => {
    // 前身工程就是宿主画的（docs/legacy/旧工程架构说明-PySide6.md）：
    // 「提示符由控制台画，不是从设备取——因为板子自己的 PS1 是纯文本」。
    const input = new PipeInput('root@board$ ');
    type(input, 'ls');
    const r = input.input('\r');
    expect(r.echo).toContain('root@board$ ');
    // 提示符只是画给人看的，不发给远端
    expect(r.toRemote).toBe('ls\n');
  });

  it('Ctrl+C 打断远端并清行', () => {
    const input = new PipeInput();
    type(input, 'sleep 100');
    const r = input.input('\x03');
    expect(r.toRemote).toBe('\x03');
    expect(r.echo).toContain('^C');
  });

  it('粘贴一段多行文本：每行都以 LF 结束', () => {
    const input = new PipeInput();
    const r = input.input('a\r\nb\r\n');
    expect(r.toRemote).toBe('a\nb\n');
  });

  it('光标移到行中间再插入，插入落在光标处', () => {
    const input = new PipeInput();
    type(input, 'ls -la');
    input.input('\x1b[D'); // 左移一格
    const r = input.input('X');
    expect(input.editor.text).toBe('ls -lXa');
    expect(input.editor.cursor).toBe(6);
    // 重画用的是 ANSI 光标移动 + 擦行
    expect(r.echo).toContain('\x1b[');
  });

  it('历史：上箭头调出上一条命令', () => {
    const input = new PipeInput();
    type(input, 'first');
    input.input('\r');
    type(input, 'second');
    input.input('\r');
    input.input('\x1b[A'); // 上箭头
    expect(input.editor.text).toBe('second');
    expect(input.input('\r').toRemote).toBe('second\n');
  });

  it('Ctrl+W 删掉一个词（连词前的空格）', () => {
    const input = new PipeInput();
    type(input, 'cat file.txt');
    input.input('\x17');
    expect(input.editor.text).toBe('cat ');
  });
});

describe('第三轮审计补的用例', () => {
  it('重画不得越过提示符 —— 提示符被擦掉就等于没提示符', () => {
    // 提示符与输入在同一行上，所以重画只能退到**文本区起点**，
    // 退过头（退到提示符之前）再擦行，就把提示符本身擦掉了。
    const input = new PipeInput('root@ATK-DLRK3588');
    const r = input.input('l');
    // 第一个字：光标就在文本区起点，一个字都不用退
    expect(r.echo).not.toContain('\x1b[17D');
    expect(r.echo).not.toContain('\x1b[15D');
    // 第二个字：退 1 列（一个字符），不是退到行首
    const r2 = input.input('s');
    expect(r2.echo).toContain('\x1b[1D');
    expect(r2.echo).not.toContain('\x1b[16D');
  });

  it('Ctrl+C 要清掉这一行 —— 用例名承诺了「清行」', () => {
    const input = new PipeInput();
    input.input('sleep 100');
    input.input('\x03');
    expect(input.editor.text).toBe('');
    // 清完之后重新输入，回车发出去的是新命令，不是两段拼起来的
    input.input('ls');
    expect(input.input('\r').toRemote).toBe('ls\n');
  });

  it('Ctrl+L 是清屏（旧工程 keymap 的规格：Clear the screen）', () => {
    const input = new PipeInput();
    input.input('ls');
    const r = input.input('\x0c');
    // 清屏 + 光标归位 + 提示符重画
    expect(r.echo).toContain('\x1b[2J');
    expect(r.echo).toContain('\x1b[H');
  });

  it('列宽按显示宽度算 —— 一个汉字占两列', () => {
    expect(displayWidth('中')).toBe(2);
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('中文abc')).toBe(7);

    const input = new PipeInput();
    input.input('中'); // 一个汉字 = 两列
    const r = input.input('文');
    // 退 2 列（显示宽度），不是退 1（UTF-16 长度）
    expect(r.echo).toContain('\x1b[2D');
  });
});

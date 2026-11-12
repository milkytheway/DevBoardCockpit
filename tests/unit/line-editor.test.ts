import { describe, it, expect } from 'vitest';
import { PipeLineEditor } from '../../src/main/terminal/line-editor';

/**
 * 管道模式的行规程。
 *
 * 这组用例对应 `docs/11-计划1评审报告.md` R-01 的**真机实测结论**：
 * pipe 模式下 `'\r'` 原样发给远端，busybox 的 shell 永远等不到行尾。
 *
 * 第一条用例是这条缺陷的守门人：
 * 有人把「回车 → 发整行 + `\n`」改回「原样转发 `\r`」，它必须变红。
 */
describe('pipe 模式的行规程', () => {
  it('回车把整行连同 LF 发给远端 —— 远端 shell 只认 LF', () => {
    const ed = new PipeLineEditor();
    ed.input('ls');
    const edit = ed.input('\r');
    expect(edit.toRemote).toBe('ls\n');
    // 回显要让用户看到自己换行了
    expect(edit.echo).toBe('\r\n');
  });

  it('打字过程中不发给远端（整行缓存在本地，退格才退得掉）', () => {
    const ed = new PipeLineEditor();
    const edit = ed.input('ls');
    // 远端什么都没收到 —— 管道里没有行规程，发出去的字收不回来
    expect(edit.toRemote).toBe('');
    // 但用户看得见自己打的字
    expect(edit.echo).toBe('ls');
  });

  it('退格删掉最后一个字符，并且**真的从发出去的那行里消失**', () => {
    const ed = new PipeLineEditor();
    ed.input('ls');
    const back = ed.input('\x7f'); // DEL —— 终端的退格键发的是它
    // 回显是「退格 + 空格 + 退格」——终端据此擦掉那个字符
    expect(back.echo).toBe('\b \b');
    expect(ed.currentLine).toBe('l');
    // 关键：远端最后收到的是 'l'，不是 'ls'
    expect(ed.input('\r').toRemote).toBe('l\n');
  });

  it('退格在空行上不做事', () => {
    const ed = new PipeLineEditor();
    const edit = ed.input('\x7f');
    expect(edit.toRemote).toBe('');
    expect(edit.echo).toBe('');
  });

  it('Ctrl+C 清行并显示 ^C', () => {
    const ed = new PipeLineEditor();
    ed.input('sleep 100');
    const edit = ed.input('\x03');
    expect(edit.toRemote).toBe('\x03');
    expect(edit.echo).toBe('^C\r\n');
    expect(ed.currentLine).toBe('');
  });

  it('Ctrl+U 删整行', () => {
    const ed = new PipeLineEditor();
    ed.input('rm -rf /');
    const edit = ed.input('\x15');
    expect(edit.echo).toBe('\b \b'.repeat('rm -rf /'.length));
    expect(ed.currentLine).toBe('');
  });

  it('Ctrl+W 删前一个词', () => {
    const ed = new PipeLineEditor();
    ed.input('ls -l /tmp');
    const edit = ed.input('\x17');
    expect(ed.currentLine).toBe('ls -l ');
    expect(edit.echo.length).toBeGreaterThan(0);
  });

  it('粘贴一段多行文本：每行都以 LF 结束', () => {
    // xterm 的粘贴会一次给一整段，行尾是 \r\n
    const ed = new PipeLineEditor();
    const edit = ed.input('a\r\nb\r\n');
    expect(edit.toRemote).toBe('a\nb\n');
  });

  it('方向键这类转义序列不回显 —— 回显会让光标动而缓冲不动', () => {
    const ed = new PipeLineEditor();
    const edit = ed.input('\x1b[A'); // 上箭头
    expect(edit.echo).toBe('');
    expect(edit.toRemote).toBe('');
  });
});

describe('pipe 模式的提示符', () => {
  it('换行后画下一个提示符 —— pipe 模式的远端不发提示符', () => {
    // 前身工程就是宿主画的（`docs/legacy/旧工程架构说明-PySide6.md`）：
    // 「提示符由控制台画，不是从设备取——因为板子自己的 PS1 是纯文本」。
    const ed = new PipeLineEditor('root@board$ ');
    ed.input('ls');
    const edit = ed.input('\r');
    // 换行 + 下一个提示符
    expect(edit.echo).toBe('\r\nroot@board$ ');
    // 提示符只是画给人看的，不发给远端
    expect(edit.toRemote).toBe('ls\n');
  });

  it('没有提示符时什么都不多画', () => {
    const ed = new PipeLineEditor();
    ed.input('ls');
    expect(ed.input('\r').echo).toBe('\r\n');
  });
});

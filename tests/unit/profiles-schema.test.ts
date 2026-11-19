import { describe, it, expect } from 'vitest';
import { parseProfile } from '../../src/main/profiles/schema';

describe('parseProfile', () => {
  it('接受一个合法的串口 profile', () => {
    const p = parseProfile({
      id: 'board-serial', label: '板子 · 串口', transport: 'serial',
      board_pack: 'rk3588-atk',
      options: { port: 'COM3', baudrate: 1500000, pty: true },
    }, 'test');
    expect(p.transport).toBe('serial');
    expect(p.options.port).toBe('COM3');
  });

  it('未知顶层字段报错（封闭 schema）', () => {
    expect(() => parseProfile({ id: 'x', label: 'x', transport: 'local', options: {}, oops: 1 }, 'test'))
      .toThrow(/Unknown field/);
  });

  it('adb 的 pty 为 true 时报错（事实 A1）', () => {
    expect(() => parseProfile({ id: 'x', label: 'x', transport: 'adb', options: { pty: true } }, 'test'))
      .toThrow(/pty/);
  });

  it('串口缺 port 报错', () => {
    expect(() => parseProfile({ id: 'x', label: 'x', transport: 'serial', options: {} }, 'test'))
      .toThrow(/port/);
  });
});

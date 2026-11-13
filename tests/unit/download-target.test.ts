import { describe, it, expect } from 'vitest';
import {
  defaultDownloadPath,
  sanitizeFileName,
  uniqueDownloadPath,
} from '../../src/main/files/download-target';
import { join } from 'node:path';

/**
 * 下载的落盘位置。
 *
 * **它守的是一条边界**：远端路径 → 宿主文件系统。
 * 远端路径将来由**卡片与 MCP** 传进来，那是外部输入——
 * 路径穿越与 Windows 文件名规则都得在这里挡住。
 */
describe('sanitizeFileName', () => {
  it('普通名字原样留着', () => {
    expect(sanitizeFileName('a.txt')).toBe('a.txt');
    expect(sanitizeFileName('我的 文件.txt')).toBe('我的 文件.txt');
  });

  it('Windows 文件名里不能用的字符换成下划线', () => {
    expect(sanitizeFileName('a:b*c?.txt')).toBe('a_b_c_.txt');
    expect(sanitizeFileName('a/b\\c.txt')).toBe('a_b_c.txt');
  });

  it('结尾的点与空格去掉 —— Windows 会悄悄去掉它们', () => {
    // 不去掉的话，「a.txt.」与「a.txt」会落成同一个文件
    expect(sanitizeFileName('a.txt.')).toBe('a.txt');
    expect(sanitizeFileName('a.txt ')).toBe('a.txt');
  });

  it('保留设备名要躲开 —— 包括带扩展名的那种', () => {
    // con.txt / nul.log / COM1.tar 在 Windows 上都是设备
    expect(sanitizeFileName('con')).toBe('_con');
    expect(sanitizeFileName('con.txt')).toBe('_con.txt');
    expect(sanitizeFileName('NUL.log')).toBe('_NUL.log');
    expect(sanitizeFileName('COM1')).toBe('_COM1');
    expect(sanitizeFileName('LPT1.tar')).toBe('_LPT1.tar');
  });

  it('空名字有兜底', () => {
    expect(sanitizeFileName('')).toBe('download');
    expect(sanitizeFileName('...')).toBe('download');
  });
});

describe('defaultDownloadPath', () => {
  it('落在下载目录 + 远端文件名', () => {
    const dir = join('C:', 'Users', 'me', 'Downloads');
    expect(defaultDownloadPath(dir, '/root/a.txt')).toBe(join(dir, 'a.txt'));
  });

  it('远端路径里的目录部分不要带过来', () => {
    const dir = join('C:', 'Users', 'me', 'Downloads');
    expect(defaultDownloadPath(dir, '/root/sub/b.txt')).toBe(join(dir, 'b.txt'));
  });

  it('远端名字带非法字符时先收拾干净', () => {
    const dir = join('C:', 'Users', 'me', 'Downloads');
    expect(defaultDownloadPath(dir, '/root/a:b.txt')).toBe(join(dir, 'a_b.txt'));
  });
});

describe('uniqueDownloadPath', () => {
  it('不撞名时就是普通路径', () => {
    const dir = join('C:', 'Users', 'me', 'Downloads');
    expect(uniqueDownloadPath(dir, '/root/a.txt', () => false)).toBe(join(dir, 'a.txt'));
  });

  it('撞名就换一个 —— 静默覆盖是数据安全问题', () => {
    const dir = join('C:', 'Users', 'me', 'Downloads');
    const taken = new Set([join(dir, 'a.txt'), join(dir, 'a-1.txt')]);
    expect(uniqueDownloadPath(dir, '/root/a.txt', (p) => taken.has(p))).toBe(
      join(dir, 'a-2.txt'),
    );
  });

  it('换名时保留扩展名', () => {
    const dir = join('C:', 'Users', 'me', 'Downloads');
    const taken = new Set([join(dir, 'a.txt')]);
    expect(uniqueDownloadPath(dir, '/root/a.txt', (p) => taken.has(p))).toBe(
      join(dir, 'a-1.txt'),
    );
  });

  it('没有扩展名时也不加多余的点', () => {
    const dir = join('C:', 'Users', 'me', 'Downloads');
    const taken = new Set([join(dir, 'a')]);
    expect(uniqueDownloadPath(dir, '/root/a', (p) => taken.has(p))).toBe(join(dir, 'a-1'));
  });
});

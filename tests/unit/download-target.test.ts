import { describe, it, expect } from 'vitest';
import {
  defaultDownloadPath,
  sanitizeFileName,
  uniqueDownloadPath,
} from '../../src/main/files/download-target';
import { join } from 'node:path';

/**
 * Where a download lands.
 *
 * **It guards one boundary**: the remote path → the file system of the host.
 * The remote path will later be handed in **by the cards and by MCP**, so it
 * is an external input — the path traversal and the rules of the Windows file
 * names have to be stopped here.
 */
describe('sanitizeFileName', () => {
  it('an ordinary name is kept as it is', () => {
    expect(sanitizeFileName('a.txt')).toBe('a.txt');
    expect(sanitizeFileName('my file.txt')).toBe('my file.txt');
  });

  it('the characters that are not allowed in a Windows file name become underscores', () => {
    expect(sanitizeFileName('a:b*c?.txt')).toBe('a_b_c_.txt');
    expect(sanitizeFileName('a/b\\c.txt')).toBe('a_b_c.txt');
  });

  it('the trailing dot and the trailing space are removed — Windows would remove them silently', () => {
    // Without the removal, "a.txt." and "a.txt" would land in the same file
    expect(sanitizeFileName('a.txt.')).toBe('a.txt');
    expect(sanitizeFileName('a.txt ')).toBe('a.txt');
  });

  it('the reserved device names are avoided — including the ones with an extension', () => {
    // con.txt / nul.log / COM1.tar are all devices on Windows
    expect(sanitizeFileName('con')).toBe('_con');
    expect(sanitizeFileName('con.txt')).toBe('_con.txt');
    expect(sanitizeFileName('NUL.log')).toBe('_NUL.log');
    expect(sanitizeFileName('COM1')).toBe('_COM1');
    expect(sanitizeFileName('LPT1.tar')).toBe('_LPT1.tar');
  });

  it('an empty name has a fallback', () => {
    expect(sanitizeFileName('')).toBe('download');
    expect(sanitizeFileName('...')).toBe('download');
  });
});

describe('defaultDownloadPath', () => {
  it('the download directory plus the remote file name', () => {
    const dir = join('C:', 'Users', 'me', 'Downloads');
    expect(defaultDownloadPath(dir, '/root/a.txt')).toBe(join(dir, 'a.txt'));
  });

  it('the directory part of the remote path is not taken over', () => {
    const dir = join('C:', 'Users', 'me', 'Downloads');
    expect(defaultDownloadPath(dir, '/root/sub/b.txt')).toBe(join(dir, 'b.txt'));
  });

  it('a remote name with illegal characters is cleaned up first', () => {
    const dir = join('C:', 'Users', 'me', 'Downloads');
    expect(defaultDownloadPath(dir, '/root/a:b.txt')).toBe(join(dir, 'a_b.txt'));
  });
});

describe('uniqueDownloadPath', () => {
  it('without a clash it is an ordinary path', () => {
    const dir = join('C:', 'Users', 'me', 'Downloads');
    expect(uniqueDownloadPath(dir, '/root/a.txt', () => false)).toBe(join(dir, 'a.txt'));
  });

  it('on a clash another name is chosen — a silent overwrite is a data safety problem', () => {
    const dir = join('C:', 'Users', 'me', 'Downloads');
    const taken = new Set([join(dir, 'a.txt'), join(dir, 'a-1.txt')]);
    expect(uniqueDownloadPath(dir, '/root/a.txt', (p) => taken.has(p))).toBe(
      join(dir, 'a-2.txt'),
    );
  });

  it('the extension is kept when the name is changed', () => {
    const dir = join('C:', 'Users', 'me', 'Downloads');
    const taken = new Set([join(dir, 'a.txt')]);
    expect(uniqueDownloadPath(dir, '/root/a.txt', (p) => taken.has(p))).toBe(
      join(dir, 'a-1.txt'),
    );
  });

  it('without an extension no extra dot is added', () => {
    const dir = join('C:', 'Users', 'me', 'Downloads');
    const taken = new Set([join(dir, 'a')]);
    expect(uniqueDownloadPath(dir, '/root/a', (p) => taken.has(p))).toBe(join(dir, 'a-1'));
  });
});

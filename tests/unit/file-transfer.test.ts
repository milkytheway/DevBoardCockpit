import { describe, it, expect } from 'vitest';
import { assertTransferAllowed, parseLsOutput } from '../../src/main/files/transfer';

describe('assertTransferAllowed', () => {
  it('串口不支持文件传输（事实 S7）', () => {
    expect(() => assertTransferAllowed({ exec: true, pty: false, files: false, exitCode: false }))
      .toThrow(/不支持文件传输/);
  });
  it('支持 files 的连接放行', () => {
    expect(() => assertTransferAllowed({ exec: true, pty: true, files: true, exitCode: true })).not.toThrow();
  });
});

describe('parseLsOutput', () => {
  it('解析出名字、类型、大小，跳过 . 与 ..', () => {
    const out = [
      'total 24',
      'drwxr-xr-x 2 root root  4096 Nov 12 09:30 sub',
      '-rw-r--r-- 1 root root   123 Nov 12 09:31 a.txt',
      'drwxr-xr-x 1 root root  4096 Nov 11 22:00 ..',
    ].join('\n');
    const entries = parseLsOutput(out, '/root');
    expect(entries.map((e) => e.name)).toEqual(['sub', 'a.txt']);
    expect(entries[0].isDirectory).toBe(true);
    expect(entries[1].isDirectory).toBe(false);
    expect(entries[1].sizeBytes).toBe(123);
    expect(entries[1].path).toBe('/root/a.txt');
  });

  it('解析不了的行跳过而不毁掉整次列举', () => {
    const entries = parseLsOutput('garbage line\n-rw-r--r-- 1 root root 7 Nov 12 09:31 b.txt', '/root');
    expect(entries.map((e) => e.name)).toEqual(['b.txt']);
  });
});

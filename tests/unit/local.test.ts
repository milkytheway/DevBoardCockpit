import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localCapabilities, LocalConnection } from '../../src/main/hal/local';

describe('localCapabilities', () => {
  it('本机一切都有', () => {
    expect(localCapabilities()).toEqual({ exec: true, pty: true, files: true, exitCode: true });
  });
});

describe('LocalConnection.exec', () => {
  it('在本机跑一条命令并拿到输出', async () => {
    const conn = new LocalConnection(
      { id: 'l', label: 'l', transport: 'local', options: {} },
      { write: () => {}, close: () => {}, filePath: 'x' } as never,
    );
    await conn.open();
    const res = await conn.exec('echo hi');
    expect(res.stdout.trim()).toBe('hi');
    expect(res.exitCode).toBe(0);
  });
});

/**
 * 本机传输的列举与上传下载。
 *
 * 之前这个文件只有 exec 的两条用例——**`list`/`pull`/`push` 一条都没测**，
 * 于是「上传的远端目标是目录」这件事没人验：
 * `copyFile(src, '/')` → ENOENT，**本机目标的上传功能不可用**。
 * （`docs/13-计划1复评报告.md` S-05）
 */
describe('LocalConnection 的文件传输', () => {
  const log = { write: () => {}, close: () => {}, filePath: 'x' } as never;
  const profile = { id: 'l', label: 'l', transport: 'local', options: {} } as const;

  function tempDir(): string {
    return mkdtempSync(join(tmpdir(), 'dbc-local-'));
  }

  it('list 列出目录内容，路径是宿主真实路径', async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'a.txt'), 'hello');
      const conn = new LocalConnection(profile, log);
      await conn.open();
      const entries = await conn.list(dir);
      expect(entries.map((e) => e.name)).toEqual(['a.txt']);
      // 路径必须是宿主上真的能用的路径
      expect(entries[0].path).toBe(join(dir, 'a.txt'));
      expect(entries[0].sizeBytes).toBe(5);
      expect(entries[0].isDirectory).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('push 的远端目标是**目录** —— 要补上 basename', async () => {
    const dir = tempDir();
    const sub = join(dir, 'sub');
    try {
      mkdirSync(sub);
      const src = join(dir, 'src.txt');
      writeFileSync(src, 'data');
      const conn = new LocalConnection(profile, log);
      await conn.open();
      await conn.push(src, sub);
      // 落在「目录/源文件名」，而不是把目录当文件名（那样会 ENOENT）
      expect(existsSync(join(sub, 'src.txt'))).toBe(true);
      expect(readFileSync(join(sub, 'src.txt'), 'utf8')).toBe('data');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pull 把远端文件取到本地', async () => {
    const dir = tempDir();
    try {
      const src = join(dir, 'src.txt');
      writeFileSync(src, 'data');
      const dst = join(dir, 'dst.txt');
      const conn = new LocalConnection(profile, log);
      await conn.open();
      await conn.pull(src, dst);
      expect(readFileSync(dst, 'utf8')).toBe('data');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

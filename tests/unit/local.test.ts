import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localCapabilities, LocalConnection } from '../../src/main/hal/local';

describe('localCapabilities', () => {
  it('everything is available on the host machine', () => {
    expect(localCapabilities()).toEqual({ exec: true, pty: true, files: true, exitCode: true });
  });
});

describe('LocalConnection.exec', () => {
  it('a command runs on the host machine and gives its output', async () => {
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
 * The listing and the upload and download of the local transfer.
 *
 * Earlier this file only had the two cases of the exec — **not a single one of
 * `list`/`pull`/`push` was tested**, so nobody verified that "the remote
 * target of an upload is a directory": `copyFile(src, '/')` → ENOENT, and
 * **the upload to the host target did not work**.
 */
describe('the file transfer of the LocalConnection', () => {
  const log = { write: () => {}, close: () => {}, filePath: 'x' } as never;
  const profile = { id: 'l', label: 'l', transport: 'local', options: {} } as const;

  function tempDir(): string {
    return mkdtempSync(join(tmpdir(), 'dbc-local-'));
  }

  it('list gives the content of the directory, the paths are the real paths of the host', async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'a.txt'), 'hello');
      const conn = new LocalConnection(profile, log);
      await conn.open();
      const entries = await conn.list(dir);
      expect(entries.map((e) => e.name)).toEqual(['a.txt']);
      // The path has to be a path that really works on the host
      expect(entries[0].path).toBe(join(dir, 'a.txt'));
      expect(entries[0].sizeBytes).toBe(5);
      expect(entries[0].isDirectory).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the remote target of push is a **directory** — the basename has to be added', async () => {
    const dir = tempDir();
    const sub = join(dir, 'sub');
    try {
      mkdirSync(sub);
      const src = join(dir, 'src.txt');
      writeFileSync(src, 'data');
      const conn = new LocalConnection(profile, log);
      await conn.open();
      await conn.push(src, sub);
      // It lands in "directory/name of the source" instead of taking the directory for the file name (that would be ENOENT)
      expect(existsSync(join(sub, 'src.txt'))).toBe(true);
      expect(readFileSync(join(sub, 'src.txt'), 'utf8')).toBe('data');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pull takes the remote file to the local machine', async () => {
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

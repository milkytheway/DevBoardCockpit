import { describe, it, expect } from 'vitest';
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

import { describe, it, expect } from 'vitest';
import { runProcess } from '../../src/main/util/spawn';

describe('runProcess', () => {
  it('拿到 stdout 与退出码', async () => {
    const r = await runProcess(process.execPath, ['-e', 'process.stdout.write("ok")']);
    expect(r.stdout).toBe('ok');
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it('超时时返回 124 且 timedOut 为 true（事实 G1）', async () => {
    const r = await runProcess(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)'], { timeoutMs: 200 });
    expect(r.exitCode).toBe(124);
    expect(r.timedOut).toBe(true);
  });

  it('输出里的坏字节不抛异常（事实 A8）', async () => {
    const r = await runProcess(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0xff, 0xfe]))']);
    expect(r.stdout.length).toBeGreaterThan(0);
  });
});

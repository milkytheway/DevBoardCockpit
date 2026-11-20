import { describe, it, expect } from 'vitest';
import { runProcess } from '../../src/main/util/spawn';

describe('runProcess', () => {
  it('it gets the stdout and the exit code', async () => {
    const r = await runProcess(process.execPath, ['-e', 'process.stdout.write("ok")']);
    expect(r.stdout).toBe('ok');
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it('on a timeout it returns 124 and timedOut is true (fact G1)', async () => {
    const r = await runProcess(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)'], { timeoutMs: 200 });
    expect(r.exitCode).toBe(124);
    expect(r.timedOut).toBe(true);
  });

  it('the broken bytes in the output throw no exception (fact A8)', async () => {
    const r = await runProcess(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0xff, 0xfe]))']);
    expect(r.stdout.length).toBeGreaterThan(0);
  });
});

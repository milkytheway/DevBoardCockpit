import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { runProcess } from '../../src/main/util/spawn';

/**
 * **Stopping it half way** (`AbortSignal`).
 *
 * Why it is a test file of its own:
 *
 * The scout measured on 2026-11-15: **a transfer step of 75 seconds ran to
 * the end after it received the cancel signal**. → The cause was not "the
 * cancellation was not passed down" but **there was no way to cancel at all**
 * back then. → Now there is one, so there has to be a criterion that guards
 * it (otherwise it silently degrades back).
 *
 * What the criterion watches is "**it really stopped**":
 *
 * → "we stopped waiting" is **not enough**: the child process is still
 *   running in the background (that was exactly the phenomenon of the scout).
 * → Therefore the criterion looks at **the process really being gone** (it
 *   cannot be found with `ps`).
 */
describe('stopping it half way', () => {
  it('**the process really was killed** (not "we stopped waiting")', async () => {
    const controller = new AbortController();

    // It sleeps for 4 seconds (**twice as long as the threshold of the criterion**):
    // → when "the cancellation did not kill the process" it runs the full 4 seconds before it ends by itself → the criterion catches it
    // → and it does not hang the test (not 10 minutes — the whole suite would hang in the sandbox)
    const running = runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], {
      signal: controller.signal,
    });

    // **It is stopped after a while**
    setTimeout(() => controller.abort(), 200);

    const result = await running;
    expect(result.cancelled).toBe(true);
    // **A cancellation is not a timeout** (the two may not share a code)
    expect(result.timedOut).toBe(false);

    // **The key criterion: after the cancellation it has to be "immediately" over**
    // → if it were only "we stopped waiting" → it would run the full 4 seconds → this would be red
    // (**the `cancelled` flag alone may not be looked at** — that is "I marked it",
    //   not "the process is really gone" — the phenomenon of the scout was exactly that the flag was right and the process was still running)
    expect(result.durationMs).toBeLessThan(2000);

    // **The process is really gone** — it looks whether the system still has it
    // (it looks for exactly the one runProcess started — its pid is in the result)
    const pid = result.pid as number;
    await new Promise((r) => setTimeout(r, 300));
    const stillThere = await new Promise<boolean>((resolve) => {
      const probe = spawn('ps', ['-p', String(pid)], { windowsHide: true, stdio: 'ignore' });
      probe.on('close', (code) => resolve(code === 0));
      probe.on('error', () => resolve(false));
    });
    expect(stillThere).toBe(false);
  });

  it('**it was cancelled right away → it is not started at all** (no wasted time)', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runProcess(process.execPath, ['-e', 'console.log(1)'], {
      signal: controller.signal,
    });
    expect(result.cancelled).toBe(true);
  });

  it('**it was not cancelled → it runs to the end** (no false alarm)', async () => {
    const result = await runProcess(process.execPath, ['-e', 'console.log("hi")'], {});
    expect(result.cancelled).toBeUndefined();
    expect(result.timedOut).toBe(false);
    expect(result.stdout.trim()).toBe('hi');
  });

  it('**a timeout is not a cancellation** (the two codes are separate — fact G1)', async () => {
    const result = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], {
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBeUndefined();
    expect(result.exitCode).toBe(124);
  });
});

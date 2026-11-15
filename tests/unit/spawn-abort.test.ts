import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { runProcess } from '../../src/main/util/spawn';

/**
 * **中途叫停**（`AbortSignal` ✓）。
 *
 * ── 为什么单独立一个测试文件 ──
 *
 * 尖兵实测（2026-11-15）：**一个 75 秒的传输步，收到取消信号后照跑完** ✗。
 * → 根因不是「取消没传下去」✓，而是**当时根本没有「取消」这条路** ✓。
 * → 现在有了 ✓，就得有判据守着 ✓（不然它会悄悄退化回去 ✓）。
 *
 * ── 这条判据盯的是「**真的停了**」 ──
 *
 * → 「不等了」**不够** ✓：子进程还在后台跑 ✗（那正是尖兵的现象 ✓）。
 * → 所以判据看的是**进程真的没了** ✓（用 `ps` 查不到 ✓）。
 */
describe('中途叫停', () => {
  it('**进程真的被杀掉了**（不是「不等了」✓）', async () => {
    const controller = new AbortController();

    const running = runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], {
      signal: controller.signal,
    });

    // **过一会儿叫停** ✓
    setTimeout(() => controller.abort(), 200);

    const result = await running;
    expect(result.cancelled).toBe(true);
    // **取消不是超时** ✓（两者不该同码 ✓）
    expect(result.timedOut).toBe(false);

    // **进程真的没了** ✓ —— 查一下系统里还有没有它 ✓
    // （查的正是 runProcess 起的那个 ✓ —— 它的 pid 在结果里 ✓）
    const pid = result.pid as number;
    await new Promise((r) => setTimeout(r, 300));
    const stillThere = await new Promise<boolean>((resolve) => {
      const probe = spawn('ps', ['-p', String(pid)], { windowsHide: true, stdio: 'ignore' });
      probe.on('close', (code) => resolve(code === 0));
      probe.on('error', () => resolve(false));
    });
    expect(stillThere).toBe(false);
  });

  it('**一开始就取消了 → 干脆别起**（不浪费时间 ✓）', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runProcess(process.execPath, ['-e', 'console.log(1)'], {
      signal: controller.signal,
    });
    expect(result.cancelled).toBe(true);
  });

  it('**没取消 → 正常跑完**（别误伤 ✓）', async () => {
    const result = await runProcess(process.execPath, ['-e', 'console.log("hi")'], {});
    expect(result.cancelled).toBeUndefined();
    expect(result.timedOut).toBe(false);
    expect(result.stdout.trim()).toBe('hi');
  });

  it('**超时 ≠ 取消**（两个码分开 ✓ —— 事实 G1 ✓）', async () => {
    const result = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], {
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBeUndefined();
    expect(result.exitCode).toBe(124);
  });
});

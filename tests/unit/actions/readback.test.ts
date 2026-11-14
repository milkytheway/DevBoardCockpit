import { describe, it, expect } from 'vitest';
import { runReadback, type ReadbackDeps } from '../../../src/main/actions/readback';
import type { TagReading } from '../../../src/shared/tag-reading';

/**
 * 回读的五种形式 —— 契约 `docs/spec/02-board-pack.md` §4.4。
 *
 * ── 为什么回读是强制的 ──
 *
 * 契约 §5.2：「**回读是强制的**。运行时在动作执行后按 `readback` 取值，
 * 把这个值作为动作结果返回。卡片**必须**用返回值渲染，不能自己乐观更新。」
 *
 * → **没回读 = 不知道板子有没有真的进入目标状态**，
 * 而驾驶舱显示「已生效」却其实没生效，是这个产品最不能有的那种错。
 */
function deps(overrides: Partial<ReadbackDeps> = {}): ReadbackDeps {
  return {
    readTag: async () => undefined,
    readFile: async () => null,
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false }),
    hasExitCode: true,
    ...overrides,
  };
}

function reading(overrides: Partial<TagReading> = {}): TagReading {
  return {
    tag: 'system.load',
    value: 1,
    unit: '',
    status: 'ok',
    at: 1_700_000_000_000,
    seq: 1,
    ...overrides,
  };
}

describe('回读 · 形式 1（tag，默认形式）', () => {
  it('值符合 → ok + verified + 值', async () => {
    const result = await runReadback(
      { tag: 'system.load', expect: '1' },
      { raw: {}, encoded: {} },
      deps({ readTag: async () => reading({ value: 1 }) }),
    );
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.value).toBe(1);
  });

  it('值不符 → 不是 ok，且说清「期望什么、实际什么」', async () => {
    const result = await runReadback(
      { tag: 'system.load', expect: '1' },
      { raw: {}, encoded: {} },
      deps({ readTag: async () => reading({ value: 0 }) }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('readback_mismatch');
    expect(result.expected).toBe('1');
    expect(result.actual).toBe(0);
  });

  it('读不到那个 tag → not_found（不是「不符」）', async () => {
    const result = await runReadback(
      { tag: 'system.load', expect: '1' },
      { raw: {}, encoded: {} },
      deps({ readTag: async () => undefined }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  it('tag 本身是 unavailable → 也不能算「确认生效」', async () => {
    const result = await runReadback(
      { tag: 'system.load', expect: '1' },
      { raw: {}, encoded: {} },
      deps({ readTag: async () => reading({ status: 'unavailable', value: null }) }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('回读 · 形式 2（file_equals）', () => {
  it('相等 → ok', async () => {
    const result = await runReadback(
      { kind: 'file_equals', path: '/sys/backlight', expect: '128' },
      { raw: {}, encoded: {} },
      deps({ readFile: async () => '128' }),
    );
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
  });

  it('不等 → mismatch', async () => {
    const result = await runReadback(
      { kind: 'file_equals', path: '/sys/backlight', expect: '128' },
      { raw: {}, encoded: {} },
      deps({ readFile: async () => '100' }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('readback_mismatch');
  });

  it('带 tolerance：差 1 在容差内 → 算符合', async () => {
    const result = await runReadback(
      { kind: 'file_equals', path: '/sys/backlight', expect: '128', tolerance: 1 },
      { raw: {}, encoded: {} },
      deps({ readFile: async () => '127' }),
    );
    expect(result.ok).toBe(true);
  });

  it('带 tolerance：差 2 超容差 → 不符', async () => {
    const result = await runReadback(
      { kind: 'file_equals', path: '/sys/backlight', expect: '128', tolerance: 1 },
      { raw: {}, encoded: {} },
      deps({ readFile: async () => '126' }),
    );
    expect(result.ok).toBe(false);
  });

  it('读不到那个文件 → not_found', async () => {
    const result = await runReadback(
      { kind: 'file_equals', path: '/sys/backlight', expect: '128' },
      { raw: {}, encoded: {} },
      deps({ readFile: async () => null }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_found');
  });
});

describe('回读 · 形式 3（command_ok）与形式 4（verify）', () => {
  it('command_ok：**动作自己那条命令**返回 0 → ok（**不跑第二条命令**）', async () => {
    let executed = 0;
    const result = await runReadback(
      { kind: 'command_ok' },
      { raw: {}, encoded: {} },
      deps({
        exec: async () => {
          executed += 1;
          return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
        },
      }),
      { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false },
    );
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    expect(executed).toBe(0);
  });

  it('command_ok：动作那条命令返回非 0 → mismatch', async () => {
    const result = await runReadback(
      { kind: 'command_ok' },
      { raw: {}, encoded: {} },
      deps(),
      { exitCode: 1, stdout: '', stderr: 'boom', durationMs: 1, timedOut: false },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('readback_mismatch');
  });

  it('**没有退出码的连接**（串口）上，command_ok 被拒绝', async () => {
    const result = await runReadback(
      { kind: 'command_ok' },
      { raw: {}, encoded: {} },
      deps({ hasExitCode: false }),
      { exitCode: null, stdout: '', stderr: '', durationMs: 1, timedOut: false },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unsupported_transport');
  });

  it('verify：命令成功 → ok', async () => {
    const result = await runReadback(
      { kind: 'verify', command: 'test -e /tmp/marker', timeout_ms: 500 },
      { raw: {}, encoded: {} },
      deps({ exec: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false }) }),
    );
    expect(result.ok).toBe(true);
  });

  it('verify：命令一直不成功 → 超时（不是「不符」）', async () => {
    const result = await runReadback(
      { kind: 'verify', command: 'test -e /tmp/marker', timeout_ms: 30 },
      { raw: {}, encoded: {} },
      deps({
        exec: async () => ({ exitCode: 1, stdout: '', stderr: '', durationMs: 1, timedOut: false }),
        sleep: async () => new Promise((r) => setTimeout(r, 5)),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('timeout');
  });

  it('**没有退出码的连接**上，verify 也被拒绝', async () => {
    const result = await runReadback(
      { kind: 'verify', command: 'test -e /tmp/marker' },
      { raw: {}, encoded: {} },
      deps({ hasExitCode: false }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unsupported_transport');
  });
});

describe('回读 · 形式 5（none）', () => {
  it('ok: true 但 **verified: false**（不是失败，也不是「什么都没说」）', async () => {
    const result = await runReadback(
      { kind: 'none', consequence: '点亮板载 LED 约 1 秒' },
      { raw: {}, encoded: {} },
      deps(),
    );
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.detail).toContain('LED');
  });
});

describe('回读 · 参数替换（expect 可以写参数名）', () => {
  it('expect 里的 {value} 用这次调用的**原始值**（不是 shell 片段）', async () => {
    const result = await runReadback(
      { kind: 'file_equals', path: '/sys/backlight', expect: '{value}' },
      { raw: { value: '128' }, encoded: { value: "'128'" } },
      deps({ readFile: async () => '128' }),
    );
    expect(result.ok).toBe(true);
  });

  it('expect 里的 {value} 换出来的值与文件不符 → mismatch', async () => {
    const result = await runReadback(
      { kind: 'file_equals', path: '/sys/backlight', expect: '{value}' },
      { raw: { value: '128' }, encoded: { value: "'128'" } },
      deps({ readFile: async () => '100' }),
    );
    expect(result.ok).toBe(false);
  });
});

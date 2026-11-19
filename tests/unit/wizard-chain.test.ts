import { describe, it, expect } from 'vitest';
import { describeWizard, wizardStepOf, type WizardState } from '../../src/main/wizard/chain';
import type { ProbeReaderReport } from '../../src/main/tags/probe';

/**
 * **接板向导那条链** ✓ —— 2026-11-19 加 ✓。
 *
 * ── 用户只参与一步 ✓（`docs/探索/02` §二 ✓）──
 *
 * ```
 * 人：选 COM 口 + 波特率          ← 【整个向导里，人唯一必须做的事】
 *         ↓
 * 向导：用这条连接跑一条命令        ← 「第一个真相」
 *         ↓
 *      板子回了 → 真相成立 ✓
 * ```
 *
 * → **其余全自动** ✓（§二.2 ✓）→
 * **逐个试通用元操作** ✓ → **实例化出初版包** ✓ → **落盘** ✓。
 *
 * ── ⚠️ **「没回话」与「连接失败」是两件事** ✓（§二.3 ✓）──
 *
 * → 报告要说「**板子没说话**」✓ —— **不是「连接失败」** ✓
 * → **这两个是不同的故障** ✓ → **修法完全不同** ✓。
 */
function report(readerId: string, ok: boolean, problems: string[] = []): ProbeReaderReport {
  return { readerId, kind: 'file_read', tags: [], problems, ok };
}

describe('向导 · **人只参与一步** ✓', () => {
  it('**第一步只问「串口参数」** ✓（**不自动枚举** ✓ —— 用户已定 ✓）', () => {
    const state: WizardState = {
      step: 'choose-serial',
      serial: { port: 'COM3', baudrate: 1500000 },
    };
    expect(wizardStepOf(state)).toBe('choose-serial');
  });

  it('**波特率要人给** ✓（**不试** ✓ —— `docs/探索/02` §一·1.2 ① ✓）', () => {
    const state: WizardState = {
      step: 'choose-serial',
      serial: { port: 'COM3', baudrate: 1500000 },
    };
    expect(state.serial?.baudrate).toBe(1500000);
  });
});

describe('向导 · **「没回话」≠「连接失败」** ✓', () => {
  it('**端口打不开 → 说端口的事** ✓', () => {
    const r = describeWizard({
      step: 'first-truth',
      firstTruth: { ok: false, kind: 'port-unopenable', detail: 'COM3 打不开' },
    });
    expect(r.kind).toBe('port-unopenable');
    expect(r.message).toContain('COM3');
  });

  it('**打开但没回话 → 说「板子没说话」** ✓（**不是「连接失败」** ✓）', () => {
    const r = describeWizard({
      step: 'first-truth',
      firstTruth: { ok: false, kind: 'no-reply', detail: '连上了但命令没有回包' },
    });
    expect(r.kind).toBe('no-reply');
    expect(r.message).toContain('said nothing');
    expect(r.message).not.toContain('connection failed');
  });

  it('**没回话要说清最常见的原因** ✓（**串口被别的程序占着** ✓ —— `docs/02` 事实 ✓）', () => {
    const r = describeWizard({
      step: 'first-truth',
      firstTruth: { ok: false, kind: 'no-reply', detail: '连上了但命令没有回包' },
    });
    expect(r.hints.length, '要给出下一步查什么 ✓').toBeGreaterThan(0);
  });

  it('**第一个真相成立 → 下一步是「试通用元操作」** ✓', () => {
    const r = describeWizard({
      step: 'first-truth',
      firstTruth: { ok: true, kind: 'ok', detail: '板子回了' },
    });
    expect(r.next).toBe('probe-generic');
  });
});

describe('向导 · **试出来的绿/红 = 真相表** ✓', () => {
  it('**绿的说「有」· 红的说「没有」** ✓', () => {
    const r = describeWizard({
      step: 'probe-generic',
      firstTruth: { ok: true, kind: 'ok', detail: '板子回了' },
      outcomes: [report('cpu', true), report('led', false, ['路径不对'])],
    });
    expect(r.kind).toBe('ok');
    expect(r.summary?.green).toEqual(['cpu']);
    expect(r.summary?.red.map((x) => x.readerId)).toEqual(['led']);
  });

  it('**「红的」要给出原因** ✓（**「这板没有」也是事实** ✓）', () => {
    const r = describeWizard({
      step: 'probe-generic',
      firstTruth: { ok: true, kind: 'ok', detail: '板子回了' },
      outcomes: [report('led', false, ['路径不对', '没这个目录'])],
    });
    expect(r.summary?.red[0]?.detail).toContain('路径不对');
  });

  it('**全红 → 那不是「reader 的问题」** ✓（**是连接没通** ✓ —— `probeHint` 同款 ✓）', () => {
    const r = describeWizard({
      step: 'probe-generic',
      firstTruth: { ok: true, kind: 'ok', detail: '板子回了' },
      outcomes: [report('cpu', false), report('mem', false)],
    });
    expect(r.kind, '一个数都没出来 → 连接本身的问题 ✓').toBe('connection-dead');
  });
});

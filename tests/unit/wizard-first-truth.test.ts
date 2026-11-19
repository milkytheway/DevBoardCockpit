import { describe, it, expect } from 'vitest';
import { firstTruthOf } from '../../src/main/wizard/run';
import { AppError } from '../../src/shared/errors';
import type { Connection, ExecResult } from '../../src/main/hal/connection';

/**
 * **「第一个真相」的故障分类** ✓ —— 2026-11-20 加 ✓。
 *
 * ── 为什么这条要加（**它是被真机事件打出来的** ✓）──
 *
 * → 实测 2026-11-20：向导对着 **COM99**（**不存在的口** ✓）跑 ✓
 *   → 宿主抛的是「**打不开**串口 COM99」✓
 * → 而当时的判据**只认消息文本** ✓（正则里是「打开」✓）
 *   → **「打不开」不含「打开」** ✓ → **没匹配上** ✓
 *   → **被归成「板子没说话」** ⚠️ → **说错了故障** ⚠️
 *   → **而这两个的修法完全不同** ⚠️（换波特率 ✓ vs 换个口 ✓）。
 *
 * → **所以：判据要认「错误码」** ✓ —— **别只认文本** ✓
 *   （**中文差一个字就分错了** ✓）。
 */
function failingConnection(err: unknown): Connection {
  return {
    id: 'fake',
    transport: 'serial',
    async exec(): Promise<ExecResult> {
      throw err;
    },
  } as unknown as Connection;
}

describe('第一个真相 · **故障分类** ✓（**认错误码** ✓）', () => {
  it('**`CONN_OPEN_FAILED` → 串口打不开** ✓（**不是「板子没说话」** ✓）', async () => {
    const err = new AppError('CONN_OPEN_FAILED', 'cannot open serial port COM99');
    const truth = await firstTruthOf(failingConnection(err));
    expect(truth.kind, '**cannot open**与「open」差一个字 ✓ → 认错误码才分得对 ✓').toBe(
      'port-unopenable',
    );
  });

  it('**`PORT_BUSY` → 串口打不开** ✓（**被占用是同一个故障** ✓）', async () => {
    const err = new AppError('PORT_BUSY', 'serial port COM3 is busy');
    const truth = await firstTruthOf(failingConnection(err));
    expect(truth.kind).toBe('port-unopenable');
  });

  it('**英文消息「cannot open」也要认** ✓（**兜底** ✓）', async () => {
    const truth = await firstTruthOf(failingConnection(new Error('cannot open serial port COM99')));
    expect(truth.kind).toBe('port-unopenable');
  });

  it('**只有错误码能认出它** ✓（**消息里没有任何关键词** ✓ —— **文本兜底救不了** ✓）', async () => {
    // → **消息是英文** ✓ → **文本兜底的正则一个都匹配不上** ✓
    // → **只有认错误码** ✓ → **才分得出「打不开」** ✓
    const err = new AppError('CONN_OPEN_FAILED', 'cannot open port');
    const truth = await firstTruthOf(failingConnection(err));
    expect(
      truth.kind,
      '**只认错误码才分得对** ✓ —— **中文差一个字就分错了** ✓（实测 2026-11-20 ⚠️）',
    ).toBe('port-unopenable');
  });

  it('**超时 → 板子没说话** ✓（**不是「打不开」** ✓）', async () => {
    const truth = await firstTruthOf(
      failingConnection(new AppError('CONN_TIMEOUT', 'serial port COM3 timed out on one round trip')),
    );
    expect(truth.kind).toBe('no-reply');
  });

  it('**别的错 → 板子没说话** ✓（**不乱归** ✓）', async () => {
    const truth = await firstTruthOf(failingConnection(new Error('the board has two cables plugged in')));
    expect(truth.kind).toBe('no-reply');
  });
});

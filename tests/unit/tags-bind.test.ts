import { describe, it, expect } from 'vitest';
import { bindSampleToTag, unitForTag } from '../../src/main/tags/vocabulary';

/**
 * sample 绑成 tag（契约 §1.1）与单位查询。
 *
 * 「`*` 的位置一一对应」指的是**第 i 个通配段**互相对应，
 * **不是同一个段号**——tag 的通配段在第 2 段，sample 的在第 1 段。
 */

describe('bindSampleToTag · sample 绑成 tag（契约 §1.1）', () => {
  it('通配段一一对应：core.3.usage → cpu.core.3.usage', () => {
    expect(bindSampleToTag('cpu.core.*.usage', 'core.*.usage', 'core.3.usage')).toBe(
      'cpu.core.3.usage',
    );
  });

  it('**通配段不是同一个段号**', () => {
    expect(bindSampleToTag('cpu.core.*.usage', 'core.*.usage', 'core.7.usage')).toBe(
      'cpu.core.7.usage',
    );
  });

  it('字面段对不上就绑不上', () => {
    expect(bindSampleToTag('cpu.core.*.usage', 'core.*.usage', 'gpu.3.usage')).toBeNull();
  });

  it('段数不对就绑不上', () => {
    expect(bindSampleToTag('cpu.core.*.usage', 'core.*.usage', 'core.3.usage.extra')).toBeNull();
  });

  it('没有通配段时就是一一对上', () => {
    expect(bindSampleToTag('cpu.usage', 'usage', 'usage')).toBe('cpu.usage');
  });

  it('通配数量不一致就绑不上（规则 7）', () => {
    expect(bindSampleToTag('cpu.core.*.usage', 'core.*.usage', 'core.3.usage')).not.toBeNull();
    expect(bindSampleToTag('cpu.core.*.*.usage', 'core.*.usage', 'core.3.usage')).toBeNull();
  });
});

describe('unitForTag · 单位从核心词表查', () => {
  it('核心词表里的 tag 拿得到单位', () => {
    expect(unitForTag('cpu.usage')).toBe('percent');
    expect(unitForTag('mem.total_bytes')).toBe('byte');
    expect(unitForTag('cpu.core.3.usage')).toBe('percent');
  });

  it('custom 命名空间的 tag 没有单位（无量纲）', () => {
    expect(unitForTag('custom.rk3588-atk.npu.duty')).toBe('-');
  });
});

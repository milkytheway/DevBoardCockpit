import { describe, it, expect } from 'vitest';
import { bindSampleToTag, unitForTag } from '../../src/main/tags/vocabulary';

/**
 * Binding a sample to a tag (contract §1.1) and the lookup of the unit.
 *
 * "The positions of the `*` correspond one to one" means that the **i-th
 * wildcard segment** of one side corresponds to the **i-th wildcard segment**
 * of the other, **not the same segment number** — the wildcard of the tag is
 * in the second segment and the one of the sample in the first.
 */

describe('bindSampleToTag · binding a sample to a tag (contract §1.1)', () => {
  it('the wildcard segments correspond one to one: core.3.usage → cpu.core.3.usage', () => {
    expect(bindSampleToTag('cpu.core.*.usage', 'core.*.usage', 'core.3.usage')).toBe(
      'cpu.core.3.usage',
    );
  });

  it('**the wildcard segments are not the same segment number**', () => {
    expect(bindSampleToTag('cpu.core.*.usage', 'core.*.usage', 'core.7.usage')).toBe(
      'cpu.core.7.usage',
    );
  });

  it('a literal segment that does not match cannot be bound', () => {
    expect(bindSampleToTag('cpu.core.*.usage', 'core.*.usage', 'gpu.3.usage')).toBeNull();
  });

  it('a different number of segments cannot be bound', () => {
    expect(bindSampleToTag('cpu.core.*.usage', 'core.*.usage', 'core.3.usage.extra')).toBeNull();
  });

  it('without a wildcard segment it is a one to one match', () => {
    expect(bindSampleToTag('cpu.usage', 'usage', 'usage')).toBe('cpu.usage');
  });

  it('a different number of wildcards cannot be bound (rule 7)', () => {
    expect(bindSampleToTag('cpu.core.*.usage', 'core.*.usage', 'core.3.usage')).not.toBeNull();
    expect(bindSampleToTag('cpu.core.*.*.usage', 'core.*.usage', 'core.3.usage')).toBeNull();
  });
});

describe('unitForTag · the unit is looked up in the core vocabulary', () => {
  it('a tag of the core vocabulary has a unit', () => {
    expect(unitForTag('cpu.usage')).toBe('percent');
    expect(unitForTag('mem.total_bytes')).toBe('byte');
    expect(unitForTag('cpu.core.3.usage')).toBe('percent');
  });

  it('a tag of the custom namespace has no unit (it is dimensionless)', () => {
    expect(unitForTag('custom.rk3588-atk.npu.duty')).toBe('-');
  });
});

import { describe, it, expect } from 'vitest';
import type { TagReading } from '../../src/shared/tag-reading';
import { readingMeta, readingValueText } from '../../src/renderer/shell/format';

function reading(overrides: Partial<TagReading> & { status: TagReading['status'] }): TagReading {
  return {
    tag: 'cpu.usage',
    value: 42.8,
    unit: '%',
    at: 1_700_000_000_000,
    seq: 1,
    ...overrides,
  };
}

describe('读数 · 七态三重编码（形状 + 颜色 + 文字）', () => {
  it('ok：实心圆 + 实时 + 显示值', () => {
    const meta = readingMeta(reading({ status: 'ok' }));
    expect(meta.glyph).toBe('●');
    expect(meta.tone).toBe('ok');
    expect(meta.showValue).toBe(true);
    expect(meta.label).toBe('实时');
  });

  it('stale：半实圆 + 琥珀 + 显示旧值（不装作是实时）', () => {
    const meta = readingMeta(reading({ status: 'stale' }));
    expect(meta.glyph).toBe('◐');
    expect(meta.tone).toBe('warn');
    expect(meta.showValue).toBe(true);
    expect(meta.label).toBe('已过时');
  });

  it('error：叉号 + 红 + 只有旧值才显示', () => {
    expect(readingMeta(reading({ status: 'error', value: 12 })).showValue).toBe(true);
    expect(readingMeta(reading({ status: 'error', value: null })).showValue).toBe(false);
    expect(readingMeta(reading({ status: 'error' })).tone).toBe('danger');
  });

  it('unavailable：斜杠 + 灰 + 绝不显示值（不能把不可用画成 0）', () => {
    const meta = readingMeta(reading({ status: 'unavailable', value: null, reason: 'not_found' }));
    expect(meta.glyph).toBe('⊘');
    expect(meta.tone).toBe('unknown');
    expect(meta.showValue).toBe(false);
    expect(meta.detail).toContain('板型包未提供');
  });

  it('pending：空心圆 + 不显示值（还没采到，不是 0）', () => {
    const meta = readingMeta(reading({ status: 'pending', value: null }));
    expect(meta.glyph).toBe('◌');
    expect(meta.showValue).toBe(false);
    expect(meta.tone).toBe('muted');
  });

  it('没有读数时也按 unavailable 的画法来，不显值', () => {
    const meta = readingMeta(undefined);
    expect(meta.tone).toBe('unknown');
    expect(meta.showValue).toBe(false);
  });

  it('没有「可用的颜色但不可读的值」：每个状态要么 showValue=true 有值，否则值不渲染', () => {
    const states: TagReading['status'][] = ['ok', 'stale', 'pending', 'error', 'unavailable'];
    for (const status of states) {
      const meta = readingMeta(reading({ status, value: status === 'error' ? null : 42.8 }));
      expect(meta.glyph.length).toBeGreaterThan(0);
      if (!meta.showValue) expect(meta.label.length).toBeGreaterThan(0);
    }
  });
});

describe('读数 · 数字格式（精度按量级，不补零，单位降一级）', () => {
  it('null 值显示 —（不可用不显示 0）', () => {
    expect(readingValueText(reading({ status: 'unavailable', value: null, unit: '%' }))).toEqual({
      value: '—',
      unit: '%',
    });
  });

  it('Hz 按量级降到 GHz / MHz', () => {
    expect(readingValueText(reading({ status: 'ok', value: 1_800_000_000, unit: 'Hz' }))).toEqual({
      value: '1.80',
      unit: 'GHz',
    });
    expect(readingValueText(reading({ status: 'ok', value: 24_000_000, unit: 'Hz' }))).toEqual({
      value: '24.0',
      unit: 'MHz',
    });
  });

  it('温度保留 1 位', () => {
    expect(readingValueText(reading({ status: 'ok', value: 61.34, unit: '°C' }))).toEqual({
      value: '61.3',
      unit: '°C',
    });
  });

  it('整数不补零，千位加分隔符', () => {
    expect(readingValueText(reading({ status: 'ok', value: 42, unit: '%' })).value).toBe('42');
    expect(readingValueText(reading({ status: 'ok', value: 1234, unit: 'MB' })).value).toBe('1,234');
  });

  it('布尔按开关显示', () => {
    expect(readingValueText(reading({ status: 'ok', value: true, unit: '' })).value).toBe('开');
    expect(readingValueText(reading({ status: 'ok', value: false, unit: '' })).value).toBe('关');
  });

  it('契约里的机器单位换成工程师看的符号（percent/hertz/celsius/bytes）', () => {
    expect(readingValueText(reading({ status: 'ok', value: 42.8, unit: 'percent' }))).toEqual({
      value: '42.8',
      unit: '%',
    });
    expect(readingValueText(reading({ status: 'ok', value: 300_000_000, unit: 'hertz' }))).toEqual({
      value: '300',
      unit: 'MHz',
    });
    expect(readingValueText(reading({ status: 'ok', value: 61.34, unit: 'celsius' }))).toEqual({
      value: '61.3',
      unit: '°C',
    });
    expect(readingValueText(reading({ status: 'ok', value: 24_117_000, unit: 'bytes' }))).toEqual({
      value: '23.0',
      unit: 'MB',
    });
  });
});

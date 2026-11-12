import { describe, it, expect } from 'vitest';
import { buildMarker, extractMarkerOutput, stripMarkers } from '../../src/main/hal/session';

describe('buildMarker', () => {
  it('格式是 __DBC<pid>_<毫秒>__ 且每次唯一', () => {
    expect(buildMarker(123, 1700000000000)).toBe('__DBC123_1700000000000__');
    expect(buildMarker(123, 1700000000001)).not.toBe(buildMarker(123, 1700000000000));
  });
});

describe('extractMarkerOutput', () => {
  it('取第一次 marker 之后到第二次之间的内容（板子回显场景）', () => {
    const m = '__DBC1_2__';
    const t = `${m}\r\nhello\r\nworld\r\n${m}\r\n`;
    expect(extractMarkerOutput(t, m)).toBe('hello\r\nworld');
  });

  it('板子不回显时取第一次之后的全部内容', () => {
    const m = '__DBC1_2__';
    expect(extractMarkerOutput(`${m}\r\nonly\r\n`, m)).toBe('only');
  });

  it('找不到 marker 时返回空串', () => {
    expect(extractMarkerOutput('nothing here', '__DBC1_2__')).toBe('');
  });
});

describe('stripMarkers', () => {
  it('把 marker 从文本里抹掉', () => {
    expect(stripMarkers('a __DBC1_2__ b', ['__DBC1_2__'])).toBe('a  b');
  });
});

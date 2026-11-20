import { describe, it, expect } from 'vitest';
import { buildMarker, extractMarkerOutput, stripMarkers } from '../../src/main/hal/session';

describe('buildMarker', () => {
  it('the format is __DBC<pid>_<ms>__ and it is unique every time', () => {
    expect(buildMarker(123, 1700000000000)).toBe('__DBC123_1700000000000__');
    expect(buildMarker(123, 1700000000001)).not.toBe(buildMarker(123, 1700000000000));
  });
});

describe('extractMarkerOutput', () => {
  it('it takes the content between the first and the second marker (the case where the board echoes)', () => {
    const m = '__DBC1_2__';
    const t = `${m}\r\nhello\r\nworld\r\n${m}\r\n`;
    expect(extractMarkerOutput(t, m)).toBe('hello\r\nworld');
  });

  it('when the board does not echo it takes everything after the first one', () => {
    const m = '__DBC1_2__';
    expect(extractMarkerOutput(`${m}\r\nonly\r\n`, m)).toBe('only');
  });

  it('when there is no marker it returns an empty string', () => {
    expect(extractMarkerOutput('nothing here', '__DBC1_2__')).toBe('');
  });
});

describe('stripMarkers', () => {
  it('it removes the marker from the text', () => {
    expect(stripMarkers('a __DBC1_2__ b', ['__DBC1_2__'])).toBe('a  b');
  });
});

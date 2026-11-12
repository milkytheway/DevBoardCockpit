import { describe, it, expect } from 'vitest';
import { makeError } from '../../src/shared/errors';

describe('makeError', () => {
  it('保留 code 与 message，并默认不可重试', () => {
    const e = makeError('CONN_TIMEOUT', '连接超时');
    expect(e.code).toBe('CONN_TIMEOUT');
    expect(e.message).toBe('连接超时');
    expect(e.retryable).toBe(false);
  });
  it('允许显式覆盖 retryable 与 detail', () => {
    const e = makeError('CONN_OPEN_FAILED', '打不开', { retryable: true, detail: { port: 'COM3' } });
    expect(e.retryable).toBe(true);
    expect(e.detail).toEqual({ port: 'COM3' });
  });
});

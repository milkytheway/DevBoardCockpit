import { describe, it, expect } from 'vitest';
import { makeError } from '../../src/shared/errors';

describe('makeError', () => {
  it('the code and the message are kept and it is not retryable by default', () => {
    const e = makeError('CONN_TIMEOUT', 'the connection timed out');
    expect(e.code).toBe('CONN_TIMEOUT');
    expect(e.message).toBe('the connection timed out');
    expect(e.retryable).toBe(false);
  });
  it('the retryable and the detail may be overridden explicitly', () => {
    const e = makeError('CONN_OPEN_FAILED', 'it cannot be opened', { retryable: true, detail: { port: 'COM3' } });
    expect(e.retryable).toBe(true);
    expect(e.detail).toEqual({ port: 'COM3' });
  });
});

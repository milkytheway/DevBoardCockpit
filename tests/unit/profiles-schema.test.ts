import { describe, it, expect } from 'vitest';
import { parseProfile } from '../../src/main/profiles/schema';

describe('parseProfile', () => {
  it('a valid serial profile is accepted', () => {
    const p = parseProfile({
      id: 'board-serial', label: 'board · serial', transport: 'serial',
      board_pack: 'rk3588-atk',
      options: { port: 'COM3', baudrate: 1500000, pty: true },
    }, 'test');
    expect(p.transport).toBe('serial');
    expect(p.options.port).toBe('COM3');
  });

  it('an unknown top-level field is reported (closed schema)', () => {
    expect(() => parseProfile({ id: 'x', label: 'x', transport: 'local', options: {}, oops: 1 }, 'test'))
      .toThrow(/Unknown field/);
  });

  it('a pty of true on adb is reported (fact A1)', () => {
    expect(() => parseProfile({ id: 'x', label: 'x', transport: 'adb', options: { pty: true } }, 'test'))
      .toThrow(/pty/);
  });

  it('a serial profile without a port is reported', () => {
    expect(() => parseProfile({ id: 'x', label: 'x', transport: 'serial', options: {} }, 'test'))
      .toThrow(/port/);
  });
});

import { describe, it, expect } from 'vitest';
import {
  buildCommand,
  encodeParams,
  renderCommand,
} from '../../../src/main/actions/encoder';
import { tokenizeCommand } from '../../../src/main/tags/floor';
import type { PackParam } from '../../../src/main/tags/schema';

/**
 * Parameter encoding — contract `docs/spec/02-board-pack.md` §4.6, the
 * injection defence.
 *
 * It is a first-class concern because the board session runs as root: a single
 * `--model 'x; reboot'` turns "start the pipeline" into "reboot the board",
 * and `reboot` is not part of the command template, so matching the template
 * against the danger floor cannot catch it.
 *
 * Encoding belongs to the runtime. A pack declares types and ranges, it does
 * not escape: ten pack authors would write ten escaping schemes and nine of
 * them would be wrong.
 */
const SCHEMA: Record<string, PackParam> = {
  model: { type: 'string', maxLength: 32 },
  fps: { type: 'integer', min: 1, max: 120 },
  ratio: { type: 'number' },
  on: { type: 'boolean' },
  mode: { type: 'enum', values: ['fast', 'slow'] },
};

describe('parameter encoding · positive cases for the four types', () => {
  it('an integer is injected as a decimal literal, without quotes', () => {
    expect(encodeParams({ fps: SCHEMA.fps! }, { fps: 30 })).toEqual({ fps: '30' });
  });

  it('a number behaves the same way', () => {
    expect(encodeParams({ ratio: SCHEMA.ratio! }, { ratio: 1.5 })).toEqual({ ratio: '1.5' });
  });

  it('boolean → true / false', () => {
    expect(encodeParams({ on: SCHEMA.on! }, { on: true })).toEqual({ on: 'true' });
    expect(encodeParams({ on: SCHEMA.on! }, { on: false })).toEqual({ on: 'false' });
  });

  it('an enum is injected verbatim (the value must be in values)', () => {
    expect(encodeParams({ mode: SCHEMA.mode! }, { mode: 'fast' })).toEqual({ mode: 'fast' });
  });

  it('a string is wrapped in single quotes', () => {
    expect(encodeParams({ model: SCHEMA.model! }, { model: 'x' })).toEqual({ model: "'x'" });
  });

  it("a single quote inside a string is escaped POSIX style (' → '\\'')", () => {
    expect(encodeParams({ model: SCHEMA.model! }, { model: "it's" })).toEqual({
      model: "'it'\\''s'",
    });
  });
});

describe('parameter encoding · injection does not change the number of arguments (this is the core of §4.6)', () => {
  it('a semicolon inside single quotes still yields a single argument', () => {
    const encoded = encodeParams({ model: SCHEMA.model! }, { model: 'x; reboot' });
    const command = renderCommand('pipeline start --model {model}', encoded);
    const tokens = tokenizeCommand(command);
    // The argument count is unchanged, so `reboot` cannot become a second command
    expect(tokens).toEqual(['pipeline', 'start', '--model', 'x; reboot']);
  });

  it('the argument count is unchanged after substitution (two words in the template, two arguments)', () => {
    const { command } = buildCommand(
      'pipeline start --model {model} --fps {fps}',
      { model: SCHEMA.model!, fps: SCHEMA.fps! },
      { model: 'x; reboot', fps: 30 },
    );
    expect(tokenizeCommand(command)).toEqual([
      'pipeline',
      'start',
      '--model',
      'x; reboot',
      '--fps',
      '30',
    ]);
  });

  it('an argument containing spaces is not split after substitution (the spaces are inside the quotes)', () => {
    const { command } = buildCommand('run {model}', { model: SCHEMA.model! }, { model: 'a b c' });
    expect(tokenizeCommand(command)).toEqual(['run', 'a b c']);
  });
});

describe('parameter encoding · negative cases (the runtime does not trust the self-description of the pack or of the caller)', () => {
  const bad = (schema: PackParam, value: unknown): () => unknown =>
    () => encodeParams({ p: schema }, { p: value });

  it('an enum value that is not in values is rejected', () => {
    expect(bad(SCHEMA.mode!, 'turbo')).toThrow(/values/);
  });

  it('an integer given a string is rejected (it looks numeric but is not)', () => {
    expect(bad(SCHEMA.fps!, '30')).toThrow(/integer/);
  });

  it('a number given NaN is rejected', () => {
    expect(bad(SCHEMA.ratio!, Number.NaN)).toThrow(/number/);
  });

  it('a boolean given a string is rejected', () => {
    expect(bad(SCHEMA.on!, 'true')).toThrow(/boolean/);
  });

  it('an integer outside min/max is rejected', () => {
    expect(bad(SCHEMA.fps!, 0)).toThrow(/out of range/);
    expect(bad(SCHEMA.fps!, 999)).toThrow(/out of range/);
  });

  it('a string longer than maxLength is rejected (an unbounded string argument is an injection surface)', () => {
    expect(bad(SCHEMA.model!, 'x'.repeat(33))).toThrow(/maxLength/);
  });

  it('a string that does not match pattern is rejected', () => {
    expect(bad({ type: 'string', maxLength: 8, pattern: '^[a-z]+$' }, 'ABC')).toThrow(/pattern/);
  });

  it('a string containing a newline is rejected (a serial line carries one command, fact S6)', () => {
    expect(bad(SCHEMA.model!, 'a\nb')).toThrow(/newline/);
  });

  it('a missing value without a default is rejected', () => {
    expect(() => encodeParams({ model: SCHEMA.model! }, {})).toThrow(/is missing/);
  });

  it('an extra argument is rejected (the caller passed an argument that was not declared)', () => {
    expect(() => encodeParams({ fps: SCHEMA.fps! }, { fps: 30, extra: 'x' })).toThrow(/is not declared/);
  });

  it('a placeholder in the template that is not declared is rejected (the template of the pack is not trusted)', () => {
    expect(() => renderCommand('run {undeclared}', { model: "'x'" })).toThrow(/placeholder/);
  });

  it('the error is an AppError and carries an error code', () => {
    try {
      encodeParams({ mode: SCHEMA.mode! }, { mode: 'turbo' });
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: 'IPC_INVALID_PAYLOAD' });
    }
  });
});

describe('parameter encoding · resolving values', () => {
  it('a missing value falls back to the default', () => {
    expect(encodeParams({ fps: { type: 'integer', default: 60 } }, {})).toEqual({ fps: '60' });
  });

  it('a supplied value wins over the default', () => {
    expect(encodeParams({ fps: { type: 'integer', default: 60 } }, { fps: 30 })).toEqual({
      fps: '30',
    });
  });
});

describe('command rendering', () => {
  it('the same placeholder twice is substituted in both places', () => {
    const encoded = encodeParams({ fps: SCHEMA.fps! }, { fps: 30 });
    expect(renderCommand('a {fps} b {fps}', encoded)).toBe('a 30 b 30');
  });

  it('a template without placeholders is returned unchanged', () => {
    expect(renderCommand('lsmod', {})).toBe('lsmod');
  });

  it('buildCommand returns everything at once: the command plus the encoded fragment of every argument (the audit records the arguments)', () => {
    const result = buildCommand('run --fps {fps}', { fps: SCHEMA.fps! }, { fps: 30 });
    expect(result.command).toBe('run --fps 30');
    expect(result.encoded).toEqual({ fps: '30' });
  });
});

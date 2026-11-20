import { describe, it, expect } from 'vitest';
import { quotePath } from '../../src/main/util/shell-quote';

/**
 * The escaping of a path before it goes into a shell command.
 *
 * **It guards an injection boundary** (AGENTS.md §6: "❌ splicing the
 * arguments into the command as they are"): a path with a `;` can push a
 * second command in.
 *
 * The remote path will later be handed in **by the cards and by MCP** — that
 * is external input.
 */
describe('quotePath', () => {
  it('the whole path is wrapped in single quotes', () => {
    expect(quotePath('/root/a.txt')).toBe("'/root/a.txt'");
  });

  it('a single quote inside the path is escaped the POSIX way', () => {
    // ' → '\''
    expect(quotePath("/root/it's.txt")).toBe("'/root/it'\\''s.txt'");
  });

  it('a space and a semicolon cannot get out', () => {
    const quoted = quotePath("/root/a b; rm -rf /");
    // The whole thing is wrapped in single quotes, so the semicolon inside it is not a command separator
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    expect(quoted).toContain('; rm -rf /');
  });

  it('a newline in the path is refused — a newline is a second command', () => {
    expect(() => quotePath('/root/a\nrm -rf /')).toThrow(/newline/);
    expect(() => quotePath('/root/a\rrm -rf /')).toThrow(/newline/);
  });

  it('a null byte in the path is refused as well', () => {
    expect(() => quotePath('/root/a\0b')).toThrow(/NUL/);
  });

  it('the error is an AppError and carries an error code', () => {
    try {
      quotePath('/a\nb');
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: 'IPC_INVALID_PAYLOAD' });
    }
  });
});

import { makeError } from '../../shared/errors';

/**
 * Escaping of paths before they enter a shell command.
 *
 * Why single quotes: when a path is pasted into a shell command verbatim, a
 * space inside the path breaks the command, and a `;` can turn it into two
 * commands.
 *
 * Why escaping the single quote alone is not enough: a newline inside the
 * path makes it a second command — the serial protocol is one line at a
 * time (device fact S6), and adb/ssh are shells. A newline has to be
 * rejected, not escaped: a legitimate path never contains one, so its
 * presence means someone is trying to smuggle in a second command.
 *
 * This function is the only copy of its kind (`hal/` and `files/` both use
 * it) — the two implementations differ only in this line, and getting the
 * direction wrong costs the whole layering its meaning.
 */
/**
 * Wraps a value according to the shell's single-quote rules.
 *
 * ── Why single quotes ──
 *
 * Inside single quotes only `'` has a special meaning → every other
 * character (`;` `&&` `|` `$` backtick, ...) is a literal. Inside quotes
 * `;` is no longer a command separator.
 *
 * ── Why newline and NUL are rejected ──
 *
 * Quotes stop a separator, but they do not stop a newline: the command
 * channel of the serial port and of the shell carries one command per line
 * (device fact S6), so a newline inside a command means a second command
 * has been smuggled in.
 *
 * @param what What this value is (the error message has to say: a path? a
 * parameter value?)
 */
export function quoteShellValue(value: string, what = '值'): string {
  if (/[\r\n\0]/.test(value)) {
    throw makeError('IPC_INVALID_PAYLOAD', `${what}里有换行或空字符，拒绝拼进命令`, {
      detail: { value },
    });
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Escaping of paths before they enter a shell command.
 *
 * It guards an injection boundary (AGENTS.md section 6: "do not paste
 * parameters into a command verbatim"): a `;` inside the path lets a second
 * command in.
 */
export function quotePath(path: string): string {
  return quoteShellValue(path, '路径');
}

/**
 * The placeholder in a command template: `{name}`.
 *
 * There is only one copy of it — the validator (`tags/validator.ts`) and the
 * encoder (`actions/encoder.ts`) have to use the same one: with a regex
 * written twice, you get the extremely hard-to-find discrepancy where the
 * validator sees no placeholder but the encoder replaces it anyway.
 */
export const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Collects every `{param}` placeholder name in the text (deduplicated) */
export function collectPlaceholders(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PLACEHOLDER)) out.add(m[1] as string);
  return [...out];
}

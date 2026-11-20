import { argStr } from './util';
import { error, isBlank, missing, ok } from './parse-util';
import type { ReaderKind } from './types';

/**
 * `exec_regex` — run one command and extract with a regular expression
 * (escape hatch 2, contract section 3.2).
 *
 * ⚠️ It runs an arbitrary command on the board.
 * The validator raises a warning for it (rule 19) and the runtime writes an
 * audit record for each execution.
 *
 * Its `command` goes into the fetch fragment verbatim, and that is
 * deliberate: escaping a command is the same as turning it into a different
 * command. Whether a pack may be installed and which commands it may run is
 * decided by the permission area and by the danger floor.
 */

export const EXEC_REGEX: ReaderKind = {
  id: 'exec_regex',
  params: {
    command: { type: 'string', required: true },
    pattern: { type: 'string', required: true },
    format: {
      type: 'enum',
      required: false,
      values: ['string', 'integer', 'number', 'float'],
    },
  },
  samples: ['value'],
  fetch(args) {
    return argStr(args, 'command');
  },
  parse(raw, args, _ctx) {
    if (isBlank(raw)) {
      return missing('the command produced no output (did it fail?)');
    }
    const pattern = argStr(args, 'pattern');
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      return error('parse_error', `the regular expression "${pattern}" does not compile`);
    }

    const m = re.exec(raw);
    if (m === null) {
      return error('parse_error', `the output has nothing matching "${pattern}"`);
    }
    const text = (m[1] ?? m[0] ?? '').trim();
    if (text.length === 0) {
      return error('parse_error', 'it matched, but the capture group is empty');
    }

    const format = argStr(args, 'format');
    if (format === 'integer') {
      const value = Number(text);
      if (!Number.isInteger(value)) {
        return error('parse_error', `"${text}" is not an integer`);
      }
      return ok({ value });
    }
    if (format === 'number' || format === 'float') {
      const value = Number(text);
      if (!Number.isFinite(value)) {
        return error('parse_error', `"${text}" is not a number`);
      }
      return ok({ value });
    }
    return ok({ value: text });
  },
};

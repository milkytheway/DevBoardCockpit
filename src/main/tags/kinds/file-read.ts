import { quotePath } from '../../util/shell-quote';
import { argStr } from './util';
import { error, isBlank, missing, ok } from './parse-util';
import type { ReaderKind } from './types';

/**
 * `file_read` — read one file (escape hatch 1, contract section 3.1).
 *
 * The most common kind. It suits "the value is a number that sits in a
 * file".
 *
 * `path` and `glob` are mutually exclusive (contract section 2.4 names
 * `path`/`glob`).
 */

export const FILE_READ: ReaderKind = {
  id: 'file_read',
  params: {
    path: { type: 'string', required: false, oneOf: ['path', 'glob'] },
    glob: { type: 'glob', required: false, oneOf: ['path', 'glob'] },
    format: {
      type: 'enum',
      required: false,
      values: ['string', 'integer', 'number', 'float'],
    },
/** Whether to strip the trailing NUL of the file (device tree models and the like) */
    strip_trailing_null: { type: 'boolean', required: false },
  },
  samples: ['value'],
  fetch(args) {
    const path = argStr(args, 'path');
    if (path.length > 0) return `cat -- ${quotePath(path)}`;
    // The glob is not escaped — it is meant to be expanded by the shell
    return `cat -- ${argStr(args, 'glob')}`;
  },
  parse(raw, args, _ctx) {
    if (isBlank(raw)) {
      return missing('the file is empty (is the path wrong? is the device not mounted?)');
    }
    let text = raw;
    if (args['strip_trailing_null'] === true) {
      text = text.replace(/\0+$/, '');
    }
    text = text.trim();

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

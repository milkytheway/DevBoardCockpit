import { quotePath } from '../../util/shell-quote';
import { argStr } from './util';
import { ok, unavailable } from './parse-util';
import type { ReaderKind } from './types';

/**
 * `file_read` —— 读一个文件（逃生门 1，契约 §3.1）。
 *
 * 最常用。适合「某个值就是一个文件里的一个数」。
 *
 * `path` 与 `glob` **二选一**（契约 §2.4 写的是 `path`/`glob`）。
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
    /** 文件尾的 NUL 要不要剥（设备树模型那种） */
    strip_trailing_null: { type: 'boolean', required: false },
  },
  samples: ['value'],
  fetch(args) {
    const path = argStr(args, 'path');
    if (path.length > 0) return `cat -- ${quotePath(path)}`;
    // glob **不转义**——它就是要被 shell 展开的
    return `cat -- ${argStr(args, 'glob')}`;
  },
  parse(raw, args, _ctx) {
    let text = raw;
    if (args['strip_trailing_null'] === true) {
      text = text.replace(/\0+$/, '');
    }
    text = text.trim();

    if (text.length === 0) {
      return unavailable('device_absent', '文件是空的（路径不对？设备没挂载？）');
    }

    const format = argStr(args, 'format');
    if (format === 'integer') {
      const value = Number(text);
      if (!Number.isInteger(value)) {
        return unavailable('parse_error', `「${text}」不是整数`);
      }
      return ok({ value });
    }
    if (format === 'number' || format === 'float') {
      const value = Number(text);
      if (!Number.isFinite(value)) {
        return unavailable('parse_error', `「${text}」不是数字`);
      }
      return ok({ value });
    }
    return ok({ value: text });
  },
};

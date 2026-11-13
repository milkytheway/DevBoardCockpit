import { quotePath } from '../../util/shell-quote';
import { argStr } from './util';
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
      type: 'string',
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
};

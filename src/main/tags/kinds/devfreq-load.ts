import { quotePath } from '../../util/shell-quote';
import { argStr } from './util';
import type { ReaderKind } from './types';

/**
 * `devfreq_load` —— devfreq 的 `load` 文件。
 *
 * **⚠️ 这个文件读出的是时钟占空比，不是利用率。**
 * 空闲时读 100（时钟满速待命），满载也读 100。
 * 所以 `measure` **必填**（契约 §2.4 末段：「沉默的默认值会骗人」），
 * 规则 3/4 负责拦住「占空比当利用率发布」。
 */

export const DEVFREQ_LOAD: ReaderKind = {
  id: 'devfreq_load',
  params: {
    path: { type: 'string', required: true },
    // **`measure` 不是可选的**——「没说是利用率」不能当成「是利用率」
    measure: { type: 'enum', required: true, values: ['utilization', 'duty_cycle'] },
  },
  samples: ['duty', 'freq_hz'],
  fetch(args) {
    return `cat -- ${quotePath(argStr(args, 'path'))}`;
  },
};

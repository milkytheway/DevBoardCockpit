import { quotePath } from '../../util/shell-quote';
import { argStr } from './util';
import type { ReaderKind } from './types';

/**
 * `rknpu_load` —— RK 专有的 NPU 利用率。
 *
 * 输出形如 `NPU load:  Core0: 12%, Core1: 9%, Core2: 5%,`
 * ——**末尾带逗号**（实测，见 `docs/06` §5.2），解析器要认这个尾巴。
 *
 * 依赖 debugfs 挂载；没挂时读不到 → 报 `unavailable`，
 * **不许退回去读 devfreq 的占空比**（那会显示 100% 但板子是闲的）。
 */

export const RKNPU_LOAD: ReaderKind = {
  id: 'rknpu_load',
  params: {
    path: { type: 'string', required: true },
  },
  samples: ['usage', 'core.*.usage'],
  fetch(args) {
    return `cat -- ${quotePath(argStr(args, 'path'))}`;
  },
};

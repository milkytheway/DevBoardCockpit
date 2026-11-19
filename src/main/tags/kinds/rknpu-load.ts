import { quotePath } from '../../util/shell-quote';
import { argStr } from './util';
import { error, isBlank, missing, ok } from './parse-util';
import type { ReaderKind } from './types';

/**
 * `rknpu_load` —— RK 专有的 NPU 利用率。
 *
 * 输出形如 `NPU load:  Core0: 12%, Core1: 9%, Core2: 5%,`
 * ——**末尾带逗号**（实测，见 `docs/06` §5.2），解析器要认这个尾巴。
 *
 * 依赖 debugfs 挂载；没挂时读不到 → 报 `unavailable`，
 * **不许退回去读 devfreq 的占空比**（那会显示 100% 但板子是闲的）。
 *
 * `usage` 是**各核的最大值**（契约 §一 的词表：npu.usage = 三个计算核的最大值）。
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
  parse(raw, _args, _ctx) {
    if (isBlank(raw)) {
      return missing('the rknpu load cannot be read (is debugfs not mounted?)');
    }
    const values: { index: number; value: number }[] = [];
    for (const m of raw.matchAll(/Core(\d+):\s*(\d+)%/g)) {
      values.push({ index: Number(m[1]), value: Number(m[2]) });
    }
    if (values.length === 0) {
      return error('parse_error', 'the rknpu load has no "CoreN: x%" (is debugfs not mounted?)');
    }

    const samples: Record<string, number | string | boolean> = {};
    for (const { index, value } of values) {
      samples[`core.${index}.usage`] = value;
    }
    samples['usage'] = Math.max(...values.map((v) => v.value));
    return ok(samples);
  },
};

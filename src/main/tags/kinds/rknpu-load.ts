import { quotePath } from '../../util/shell-quote';
import { argStr } from './util';
import { error, isBlank, missing, ok } from './parse-util';
import type { ReaderKind } from './types';

/**
 * `rknpu_load` — the RK-specific NPU utilisation.
 *
 * The output looks like `NPU load:  Core0: 12%, Core1: 9%, Core2: 5%,`
 * — the line ends with a comma ✓ (measured), so the parser has to accept that
 * tail.
 *
 * It depends on debugfs being mounted; without it the file cannot be read →
 * report `unavailable`, and never fall back to the devfreq duty cycle (that
 * would show 100% while the board is idle).
 *
 * `usage` is the maximum across the cores (the vocabulary in contract
 * section 1: npu.usage = the maximum of the three compute cores).
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

import { quotePath } from '../../util/shell-quote';
import { argStr } from './util';
import { error, isBlank, missing, ok } from './parse-util';
import type { ReaderKind } from './types';

/**
 * `devfreq_load` — the `load` file of a devfreq governor.
 *
 * ⚠️ What this file reports is the clock duty cycle, not the utilisation.
 * It reads 100 when idle (the clock at full speed, standing by) and 100
 * when saturated. The value of `measure` is therefore watched by rules 3 and
 * 4 ("a silent default lies"): rule 3 rejects a duty cycle named `usage`,
 * rule 4 rejects a `usage` that does not declare its `measure`.
 *
 * Format: `<duty>@<freq>Hz` (measured: `100@1000000000Hz`).
 */

export const DEVFREQ_LOAD: ReaderKind = {
  id: 'devfreq_load',
  params: {
    path: { type: 'string', required: true },
    // `measure` is not required in the schema — a reader that only provides
    // `freq_hz` does not need it. But when it is bound to `*.usage` it has to
    // be declared (contract section 2.4, last paragraph: "a binding to
    // `*.usage` without a declared `measure` is a validator error").
    //
    // That context-dependent requirement is rule 4, so it cannot be expressed
    // through the schema's `required` flag: "measure not declared" would
    // then be reported as rule 9, rule 4 could never be reached, and two
    // rules would end up covering the same thing.
    measure: { type: 'enum', required: false, values: ['utilization', 'duty_cycle'] },
  },
  samples: ['duty', 'freq_hz'],
  fetch(args) {
    return `cat -- ${quotePath(argStr(args, 'path'))}`;
  },
  parse(raw, _args, _ctx) {
    if (isBlank(raw)) {
      return missing('the devfreq load file cannot be read (is the path wrong?)');
    }
    const text = raw.trim();
    const m = /^(\d+(?:\.\d+)?)@(\d+)Hz$/.exec(text);
    if (m === null) {
      return error(
        'parse_error',
        `the devfreq load file has the wrong format (expected "<duty>@<freq>Hz", it is "${text}")`,
      );
    }
    const duty = Number(m[1]);
    const freq = Number(m[2]);
    if (!Number.isFinite(duty) || !Number.isFinite(freq)) {
      return error('parse_error', 'the devfreq load file contains a number that cannot be read');
    }
    return ok({ duty, freq_hz: freq });
  },
};

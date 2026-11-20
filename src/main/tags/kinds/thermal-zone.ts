import { argStr, argMap } from './util';
import { error, isBlank, missing, ok } from './parse-util';
import type { ReaderKind } from './types';

/**
 * `thermal_zone` — the temperature.
 *
 * The zones are merged by `type`, not by index (measured: `thermal_zone5`
 * is the gpu; the index varies from board to board, the `type` does not).
 *
 * The fetch is a loop: for every zone directory it reads the two files
 * `type` and `temp` and prints one line `type=value` (the same shape as the
 * real-device samples and as the collection script of the predecessor
 * project).
 *
 * The merge is done by `type_map`: `soc-thermal` → `soc`. A zone that is
 * not in the map is skipped (the board has more zones than the map — that
 * is not an error, it means "this card only cares about these few").
 *
 * Millidegrees to Celsius (÷1000) is the reader's responsibility.
 */

export const THERMAL_ZONE: ReaderKind = {
  id: 'thermal_zone',
  params: {
    glob: { type: 'glob', required: true },
    /** The name in the `type` file → the segment in the sample (`soc-thermal` → `soc`) */
    type_map: { type: 'map', required: true },
  },
  samples: ['zone.*'],
  fetch(args) {
    const glob = argStr(args, 'glob');
    return (
      `for d in ${glob}; do ` +
      `printf '%s=%s\\n' "$(cat -- "$d/type" 2>/dev/null)" "$(cat -- "$d/temp" 2>/dev/null)"; ` +
      `done`
    );
  },
  parse(raw, args, _ctx) {
    if (isBlank(raw)) {
      return missing('the thermal zone cannot be read (is the path wrong?)');
    }
    const map = argMap(args, 'type_map');
    const samples: Record<string, number | string | boolean> = {};

    for (const line of raw.split(/\r?\n/)) {
      const at = line.indexOf('=');
      if (at < 0) continue;
      const type = line.slice(0, at).trim();
      const valueText = line.slice(at + 1).trim();
      if (type.length === 0 || valueText.length === 0) continue;

      // Look up the name as it is first; if that misses, try dropping the
      // `-thermal` suffix
      const key = map[type] ?? map[type.replace(/-thermal$/, '')];
      if (key === undefined) continue;

      const value = Number(valueText);
      if (!Number.isFinite(value)) continue;

      samples[`zone.${key}`] = value / 1000;
    }

    if (Object.keys(samples).length === 0) {
      return error('parse_error', 'not a single thermal zone was recognised (does the type_map not match? was the path read wrong?)');
    }
    return ok(samples);
  },
};

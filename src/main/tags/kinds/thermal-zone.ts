import { argStr, argMap } from './util';
import { error, isBlank, missing, ok } from './parse-util';
import type { ReaderKind } from './types';

/**
 * `thermal_zone` —— 温度。
 *
 * **按 `type` 归并，不按序号**（实测：`thermal_zone5` 是 gpu，
 * 序号会随板子变，`type` 不会）。
 *
 * 取数是一个循环：每个 zone 目录读 `type` 与 `temp` 两个文件，
 * 输出一行 `type=value`（**与真机样本、前身工程的采集脚本同一种形状**）。
 *
 * **归并靠 `type_map`**：`soc-thermal` → `soc`。
 * 不在映射里的 zone **被跳过**（板上有的 zone 比映射多——
 * 那不是错误，是「这张卡只关心这几个」）。
 *
 * **毫度 → 摄氏度**（÷1000）是 reader 的责任（`docs/06` C6）。
 */

export const THERMAL_ZONE: ReaderKind = {
  id: 'thermal_zone',
  params: {
    glob: { type: 'glob', required: true },
    /** `type` 文件里的名字 → sample 里的段（`soc-thermal` → `soc`） */
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
      return missing('温度 zone 读不到（路径不对？）');
    }
    const map = argMap(args, 'type_map');
    const samples: Record<string, number | string | boolean> = {};

    for (const line of raw.split(/\r?\n/)) {
      const at = line.indexOf('=');
      if (at < 0) continue;
      const type = line.slice(0, at).trim();
      const valueText = line.slice(at + 1).trim();
      if (type.length === 0 || valueText.length === 0) continue;

      // 先按原样找，找不到再试剥掉 `-thermal` 后缀
      const key = map[type] ?? map[type.replace(/-thermal$/, '')];
      if (key === undefined) continue;

      const value = Number(valueText);
      if (!Number.isFinite(value)) continue;

      samples[`zone.${key}`] = value / 1000;
    }

    if (Object.keys(samples).length === 0) {
      return error('parse_error', '一个温度 zone 都没认出来（type_map 对不上？路径没读对？）');
    }
    return ok(samples);
  },
};

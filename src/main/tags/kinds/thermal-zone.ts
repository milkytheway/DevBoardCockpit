import { argStr } from './util';
import type { ReaderKind } from './types';

/**
 * `thermal_zone` —— 温度。
 *
 * **按 `type` 归并，不按序号**（实测：`thermal_zone5` 是 gpu，
 * 序号会随板子变，`type` 不会）。
 *
 * 取数是一个循环：每个 zone 目录读 `type` 与 `temp` 两个文件，
 * 输出一行 `type<TAB>值`。**`-thermal` 后缀由解析器剥**——
 * 归并到 `temp.soc` 时不能整串当名字（实测值 `soc-thermal`）。
 *
 * glob **不转义**——它就是要被 shell 展开的。
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
      `printf '%s\\t' "$(cat -- "$d/type" 2>/dev/null)"; ` +
      `cat -- "$d/temp" 2>/dev/null; echo; ` +
      `done`
    );
  },
};

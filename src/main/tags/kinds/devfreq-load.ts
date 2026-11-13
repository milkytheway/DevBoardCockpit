import { quotePath } from '../../util/shell-quote';
import { argStr } from './util';
import { ok, unavailable } from './parse-util';
import type { ReaderKind } from './types';

/**
 * `devfreq_load` —— devfreq 的 `load` 文件。
 *
 * **⚠️ 这个文件读出的是时钟占空比，不是利用率。**
 * 空闲时读 100（时钟满速待命），满载也读 100。
 * 所以 `measure` 的取值被**规则 3/4** 看住（「沉默的默认值会骗人」）：
 * 规则 3 拦「占空比叫 usage」，规则 4 拦「叫 usage 却没说 measure」。
 *
 * 格式：`<duty>@<freq>Hz`（实测 `100@1000000000Hz`）。
 */

export const DEVFREQ_LOAD: ReaderKind = {
  id: 'devfreq_load',
  params: {
    path: { type: 'string', required: true },
    // `measure` 在 **schema 里不是必填**——一个只提供 `freq_hz` 的 reader
    // 不需要它。**但绑到 `*.usage` 时它必须被声明**（契约 §2.4 末段：
    // 「绑到 `*.usage` 而没声明 `measure`，校验器报错」）。
    //
    // 那一条**上下文相关的强制**就是**规则 4**——所以它不能靠 schema 的
    // `required` 表达（那样「没声明 measure」会被报成规则 9，规则 4 就永远
    // 走不到，**两条规则管同一件事**）。
    measure: { type: 'enum', required: false, values: ['utilization', 'duty_cycle'] },
  },
  samples: ['duty', 'freq_hz'],
  fetch(args) {
    return `cat -- ${quotePath(argStr(args, 'path'))}`;
  },
  parse(raw, _args, _ctx) {
    const text = raw.trim();
    const m = /^(\d+(?:\.\d+)?)@(\d+)Hz$/.exec(text);
    if (m === null) {
      return unavailable(
        'parse_error',
        `devfreq 的 load 文件格式不对（期望「<duty>@<freq>Hz」，实际是「${text}」）`,
      );
    }
    const duty = Number(m[1]);
    const freq = Number(m[2]);
    if (!Number.isFinite(duty) || !Number.isFinite(freq)) {
      return unavailable('parse_error', 'devfreq 的 load 文件里有读不出来的数');
    }
    return ok({ duty, freq_hz: freq });
  },
};

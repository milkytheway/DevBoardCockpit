import { quotePath } from '../../util/shell-quote';
import { argStr } from './util';
import { error, isBlank, missing, ok } from './parse-util';
import type { ReaderKind } from './types';

/**
 * `script` —— 逃生舱（契约 §3.3）。
 *
 * 脚本必须**输出 JSON**，键就是它提供的 sample 名。
 * 所以它是**唯一一个 sample 名段数不限的 kind**。
 *
 * **脚本在板子上跑**。它住在包目录里（宿主上），但要读板子的状态，
 * 所以运行时必须先把它**推到板子上**（落在 `/tmp` 下的一次会话目录里），
 * 之后每次 poll 只是带上路径执行它。
 *
 * → 所以取数用的是**远端路径**（运行时给的 `remote_path`），
 * 不是包里写的宿主路径。
 *
 * **⚠️ 它在板子上执行任意代码。** 校验器对它**报警告**（规则 19），
 * 它的执行事件进审计日志（§3.3 末段）。
 */

export const SCRIPT: ReaderKind = {
  id: 'script',
  params: {
    /** **宿主**上的路径（包声明的） */
    path: { type: 'string', required: true },
    interpreter: { type: 'string', required: true },
    format: { type: 'string', required: false, values: ['json'] },
  },
  samples: ['value'],
  unboundedSamples: true,
  fetch(args) {
    // 远端路径（推上去之后）优先；没有就退回宿主路径——
    // 退回总比什么都不做要好（真机验收时它至少能看出「脚本没推上去」）。
    const remote = argStr(args, 'remote_path');
    const target = remote.length > 0 ? remote : argStr(args, 'path');
    return `${quotePath(argStr(args, 'interpreter'))} ${quotePath(target)}`;
  },
  parse(raw, _args, _ctx) {
    if (isBlank(raw)) {
      return missing('脚本没有输出（脚本没推上去？跑失败了吗？）');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return error('parse_error', '脚本输出不是合法 JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return error('parse_error', '脚本输出不是一个 JSON 对象');
    }

    const samples: Record<string, number | string | boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // 只认标量值——嵌套的对象/数组**不是** sample
      if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
        samples[key] = value;
      }
    }
    if (Object.keys(samples).length === 0) {
      return error('parse_error', '脚本输出里一个能用的 sample 都没有');
    }
    return ok(samples);
  },
};

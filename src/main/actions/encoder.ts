import { makeError } from '../../shared/errors';
import { quoteShellValue, PLACEHOLDER } from '../util/shell-quote';
import type { PackParam } from '../tags/schema';

/**
 * 参数编码 —— 契约 `docs/spec/02-board-pack.md` §4.6「注入防线」。
 *
 * ── 为什么它是运行时的事 ──
 *
 * 板端会话是 root 权限（`docs/02` 事实 A1/S1 一带的实测）。
 * 一条 `--model 'x; reboot'` 就能把「启动管线」变成「重启板子」——
 * 而 `reboot` **不在命令模板里**，所以危险地板按模板匹配**根本拦不住**
 * （§5.3 说过这件事）。
 *
 * → **参数值按类型编码后再注入**，包只声明类型与范围，不负责转义
 * （十个包作者会写出十种转义方式，其中九种是错的）。
 *
 * ── 运行时**再校验一次**（§4.6 规则 4）──
 *
 * 不信任包的自述，也不信任调用方的自述：
 * 声明是 `integer` 而传进来的是 `'30'`，**不放行**。
 */

/** 编码的结果 */
export interface EncodedParams {
  /** 编码后的命令（可以直接执行） */
  command: string;
  /** 每个参数的编码片段 —— **审计要记参数**（`spec/02` §5.4） */
  encoded: Record<string, string>;
}

/** 参数不合法 */
function invalid(param: string, message: string): Error {
  return makeError('IPC_INVALID_PAYLOAD', `参数「${param}」${message}`, {
    detail: { param },
  });
}

/** 值落在 min/max 之外 → 拒掉 */
function checkRange(param: string, value: number, spec: PackParam): void {
  if (spec.min !== undefined && value < spec.min) {
    throw invalid(param, `超出范围（最小 ${spec.min}）`);
  }
  if (spec.max !== undefined && value > spec.max) {
    throw invalid(param, `超出范围（最大 ${spec.max}）`);
  }
}

/**
 * 按类型编码一个参数值。
 *
 * | type | 编码 |
 * |---|---|
 * | `integer` / `number` | 十进制字面量，**不带引号、不带任何其他字符** |
 * | `boolean` | `true` / `false` |
 * | `enum` | 必须是 `values` 里的某一项，**原样注入** |
 * | `string` | **单引号包裹**，`'` 转义为 `'\''`，长度不超 `maxLength` |
 */
function encodeValue(param: string, spec: PackParam, raw: unknown): string {
  switch (spec.type) {
    case 'integer': {
      if (typeof raw !== 'number' || !Number.isInteger(raw)) {
        throw invalid(param, '要 integer（整数）');
      }
      checkRange(param, raw, spec);
      return String(raw);
    }
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        throw invalid(param, '要 number（数字）');
      }
      checkRange(param, raw, spec);
      return String(raw);
    }
    case 'boolean': {
      if (typeof raw !== 'boolean') {
        throw invalid(param, '要 boolean（布尔值）');
      }
      return raw ? 'true' : 'false';
    }
    case 'enum': {
      if (typeof raw !== 'string') {
        throw invalid(param, '要字符串');
      }
      const values = spec.values ?? [];
      if (!values.includes(raw)) {
        throw invalid(param, `的取值必须是这些之一：${values.join(' / ')}`);
      }
      return raw;
    }
    case 'string': {
      if (typeof raw !== 'string') {
        throw invalid(param, '要字符串');
      }
      if (spec.maxLength !== undefined && raw.length > spec.maxLength) {
        throw invalid(param, `长度超过 maxLength（最多 ${spec.maxLength} 个字符）`);
      }
      if (spec.pattern !== undefined && !new RegExp(spec.pattern).test(raw)) {
        throw invalid(param, `不匹配 pattern（${spec.pattern}）`);
      }
      return quoteShellValue(raw, '参数值');
    }
  }
}

/**
 * 把参数按类型编码。
 *
 * @param schema 包里声明的参数（类型 + 范围）。
 * @param values 调用方给的值。
 * @returns 每个参数的编码片段。
 * @throws 参数不合法（`IPC_INVALID_PAYLOAD`）——**执行前**就拒掉。
 */
export function encodeParams(
  schema: Record<string, PackParam>,
  values: Record<string, unknown>,
): Record<string, string> {
  const encoded: Record<string, string> = {};
  for (const [name, spec] of Object.entries(schema)) {
    const has = Object.prototype.hasOwnProperty.call(values, name);
    const raw = has ? values[name] : spec.default;
    if (raw === undefined) {
      throw invalid(name, '缺少这个参数（也没有 default）');
    }
    encoded[name] = encodeValue(name, spec, raw);
  }
  // **多出来的参数 → 拒掉**：调用方塞了一个没声明的参数，
  // 说明它以为这个参数存在（拼错了？或者偷偷多塞）→ 两种都不该放行。
  for (const name of Object.keys(values)) {
    if (!Object.prototype.hasOwnProperty.call(schema, name)) {
      throw invalid(name, '没有声明这个参数');
    }
  }
  return encoded;
}

/**
 * 把命令模板里的 `{param}` 换成编码后的片段。
 *
 * **引号是编码的一部分** —— 片段**原样**放进去（`{model}` → `'x'`）。
 *
 * @throws 模板里有没声明的占位（`IPC_INVALID_PAYLOAD`）。
 */
export function renderCommand(template: string, encoded: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = encoded[name];
    if (value === undefined) {
      throw makeError('IPC_INVALID_PAYLOAD', `命令模板里的占位「{${name}}」没有声明`, {
        detail: { param: name },
      });
    }
    return value;
  });
}

/**
 * 一次到位：校验 → 编码 → 渲染。
 *
 * @returns 命令 + 每个参数的编码片段（审计要记参数）。
 */
export function buildCommand(
  template: string,
  schema: Record<string, PackParam>,
  values: Record<string, unknown>,
): EncodedParams {
  const encoded = encodeParams(schema, values);
  return { command: renderCommand(template, encoded), encoded };
}

/**
 * kind 们共用的小工具。
 *
 * **为什么参数取值要「温和」地拿**：包的参数是**数据**，不是代码。
 * 缺了就当成空串——**真正的「缺必填参数」由校验器报**（规则 9），
 * 取数片段不该在这里抛异常（那会把「包写错了」变成「取数崩了」，
 * 两者的定位完全不同）。
 */

/** 取一个字符串参数 */
export function argStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v : '';
}

/** 取一个映射参数（`type_map`） */
export function argMap(args: Record<string, unknown>, key: string): Record<string, string> {
  const v = args[key];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
    if (typeof item === 'string') out[k] = item;
  }
  return out;
}

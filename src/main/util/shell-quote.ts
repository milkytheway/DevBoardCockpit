import { makeError } from '../../shared/errors';

/**
 * 路径进 shell 命令前的转义。
 *
 * **为什么要单引号包裹**：路径原样拼进 shell 命令时，
 * 路径里有空格就断，而 `;` 之类能让命令变成两条。
 *
 * **为什么只转义单引号还不够**：路径里如果有换行，
 * 它就是**第二条命令**——串口是「一次一行」的协议（事实 S6），
 * adb/ssh 是 shell。换行必须**拒掉**，不是转义掉：
 * 一个合法路径里不会有换行，出现了就是有人想塞第二条命令。
 *
 * 这个函数是**唯一**的一份（`hal/` 与 `files/` 都用它）——
 * 两份实现的差别只有这一行，方向错误的代价是整个分层失去意义。
 */
/**
 * 把一个值按 shell 的**单引号规则**包起来。
 *
 * ── 为什么是单引号 ──
 *
 * 单引号里**只有** `'` 有特殊含义 → 其余字符（`;` `&&` `|` `$` 反引号 …）
 * 全是字面量。`;` 在引号里就不是命令分隔符了。
 *
 * ── 换行与空字符为什么拒掉 ──
 *
 * 引号能挡住分隔符，**挡不住换行**：串口与 shell 的命令通道是**一行一条命令**
 * （事实 S6），命令里带换行 = 塞进了第二条命令。
 *
 * @param what 这个值是什么（报错时要说清楚：路径？参数值？）
 */
export function quoteShellValue(value: string, what = '值'): string {
  if (/[\r\n\0]/.test(value)) {
    throw makeError('IPC_INVALID_PAYLOAD', `${what}里有换行或空字符，拒绝拼进命令`, {
      detail: { value },
    });
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 路径进 shell 命令前的转义。
 *
 * **它守的是一条注入边界**（AGENTS.md §6：「❌ 把参数原样拼进命令」）：
 * 路径里带 `;` 就能塞进第二条命令。
 */
export function quotePath(path: string): string {
  return quoteShellValue(path, '路径');
}

/**
 * 命令模板里的占位：`{name}`。
 *
 * **唯一一份** —— 校验器（`tags/validator.ts`）与编码器（`actions/encoder.ts`）
 * 必须用同一个：两处各写一个正则，就会出现「校验器认为没有占位、
 * 编码器却替换了它」这种极难查的偏差。
 */
export const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** 取出文本里所有的 `{param}` 占位名（去重） */
export function collectPlaceholders(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PLACEHOLDER)) out.add(m[1] as string);
  return [...out];
}

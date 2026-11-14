import type { FakeDevice } from './device';

/**
 * ⚠️ **假设备** —— 把采样器的命令「执行」在虚拟板子上。
 *
 * ── 为什么自己写一个小 shell ──
 *
 * 因为**采样器的取数命令就是 shell 命令**：
 *
 * ```
 * echo '<marker>'; cat -- '<路径>'; echo '<分隔行>'; cat -- '<另一路径>'; echo '<marker>'
 * ```
 *
 * 加上 thermal 的 `for d in <glob>; do printf …; done`。
 *
 * ── 为什么不能按 marker 切字符串 ──
 *
 * 因为 `proc_stat` 的取数片段里**自己带一个 echo**（分隔行 `--- cpuinfo ---`）。
 * 按 marker 切，**切到哪一步全靠运气**：分隔行被当成 marker 的时候，
 * kind 报的是 parse_error，而**原因在假设备里，看板子里看不出来**——
 * 那是**假的板子教错了真的代码**。
 *
 * → 所以这里**按 shell 语义跑**：`;` 分语句、引号包住参数、
 * `$( )` 做命令替换、`for … do … done` 展开 glob。
 *
 * ── 认不出来的语句一律不输出 ──
 *
 * **不猜**：假设备宁可说「我不知道」，也不要编一个数出来。
 */

/** 一个词：文本 + 有没有被引号包过（被包过的不做变量替换） */
interface Word {
  text: string;
  quoted: boolean;
}

/** 找到与 `open` 位置上的 `(` 配对的 `)`（跳过引号里的括号） */
function findClosingParen(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

/**
 * 读一个**双引号**包住的词。
 *
 * 双引号里可以有 `$( )`（命令替换照样求值），
 * 而且**命令替换里面还能有引号**——
 * `"$(cat -- "$d/type")"` 是 shell 里最常见的写法之一，
 * 所以这里必须**递归**地读，不能简单地「找下一个 `"`」。
 */
function readDoubleQuoted(
  device: FakeDevice,
  text: string,
  start: number,
): { text: string; next: number } {
  let out = '';
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\' && i + 1 < text.length) {
      out += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === '$' && text[i + 1] === '(') {
      const end = findClosingParen(text, i + 1);
      out += evalStatement(device, text.slice(i + 2, end));
      i = end + 1;
      continue;
    }
    if (ch === '"') return { text: out, next: i + 1 };
    out += ch;
    i += 1;
  }
  return { text: out, next: text.length };
}

/**
 * 把一条语句切成词。
 *
 * - `'...'`：原样（**不做任何替换**）
 * - `"..."`：原样，但 `$( )` 照样求值
 * - `$(...)`：命令替换——**递归求值**
 */
function splitWords(device: FakeDevice, statement: string): Word[] {
  const words: Word[] = [];
  let i = 0;
  while (i < statement.length) {
    const ch = statement[i]!;
    if (ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }
    if (ch === "'") {
      const end = statement.indexOf("'", i + 1);
      const raw = end < 0 ? statement.slice(i + 1) : statement.slice(i + 1, end);
      words.push({ text: raw, quoted: true });
      i = end < 0 ? statement.length : end + 1;
      continue;
    }
    if (ch === '"') {
      const read = readDoubleQuoted(device, statement, i);
      words.push({ text: read.text, quoted: true });
      i = read.next;
      continue;
    }
    if (ch === '$' && statement[i + 1] === '(') {
      const end = findClosingParen(statement, i + 1);
      const inner = statement.slice(i + 2, end);
      words.push({ text: evalStatement(device, inner), quoted: true });
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < statement.length && statement[j] !== ' ' && statement[j] !== '\t') j += 1;
    words.push({ text: statement.slice(i, j), quoted: false });
    i = j;
  }
  return words;
}

/** 是不是重定向（`2>/dev/null`）或选项（`--`）——这两类不是路径 */
function isNotAPath(word: Word): boolean {
  return word.text.startsWith('-') || word.text.includes('>');
}

/**
 * 跑一条语句，返回它打印出来的东西。
 *
 * **认不出来的 → 空输出**（不猜）。
 */
function evalStatement(device: FakeDevice, statement: string): string {
  const words = splitWords(device, statement);
  if (words.length === 0) return '';
  const command = words[0]!.text;

  if (command === 'echo') {
    // 真的 `echo` 用空格连参数
    return `${words.slice(1).map((w) => w.text).join(' ')}\n`;
  }

  if (command === 'cat') {
    const path = words.slice(1).find((w) => !isNotAPath(w));
    if (path === undefined) return '';
    // **文件不存在 → 一个字都没有**（真 cat 也是这样：错在 stderr）
    return device.read(path.text) ?? '';
  }

  if (command === 'printf') {
    const format = words[1]?.text ?? '';
    const args = words.slice(2).map((w) => w.text);
    let out = '';
    let argIndex = 0;
    for (let i = 0; i < format.length; i += 1) {
      if (format[i] === '%' && format[i + 1] === 's') {
        out += args[argIndex] ?? '';
        argIndex += 1;
        i += 1;
        continue;
      }
      if (format[i] === '\\' && format[i + 1] === 'n') {
        out += '\n';
        i += 1;
        continue;
      }
      out += format[i];
    }
    return out;
  }

  // **认不出来 → 什么都不给**
  return '';
}

/**
 * 按 `;` 切语句（引号与括号里的 `;` 不算）。
 */
function splitStatements(text: string): string[] {
  const out: string[] = [];
  let buffer = '';
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== null) {
      buffer += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      buffer += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ';' && depth === 0) {
      out.push(buffer);
      buffer = '';
      continue;
    }
    buffer += ch;
  }
  out.push(buffer);
  return out;
}

/**
 * 跑一串语句。
 *
 * `for <变量> in <glob>; do <循环体>; done` 会被**展开**：
 * 循环体里的 `$变量` 先替换成 glob 的每一项，再逐项跑一遍。
 */
function runShell(device: FakeDevice, statements: string[]): string {
  let out = '';
  let i = 0;
  while (i < statements.length) {
    const statement = statements[i]!.trim();
    if (statement === '') {
      i += 1;
      continue;
    }

    const forHead = /^for\s+(\w+)\s+in\s+(.+)$/.exec(statement);
    if (forHead !== null) {
      const variable = forHead[1]!;
      const pattern = forHead[2]!.trim();
      // 循环体：从 `do` 那句到 `done` 之前
      const body: string[] = [];
      i += 1;
      while (i < statements.length && !/^done\b/.test(statements[i]!.trim())) {
        body.push(statements[i]!.trim().replace(/^do\s+/, ''));
        i += 1;
      }
      i += 1; // 跳过 done
      const bodyText = body.join('; ');
      for (const match of device.glob(pattern)) {
        const substituted = bodyText.replace(
          new RegExp(`\\$${variable}(?![A-Za-z0-9_])`, 'g'),
          () => match,
        );
        out += runShell(device, splitStatements(substituted));
      }
      continue;
    }

    out += evalStatement(device, statement);
    i += 1;
  }
  return out;
}

/**
 * Run a command on the fake board.
 *
 * The command the sampler builds is a sequence of
 * `echo '<start>'; <fragment>; echo '<end>'` — so the output has to carry the
 * same markers back, in the same order, or `splitSections` cannot cut it.
 */
export function fakeExecOutput(
  device: FakeDevice,
  command: string,
  opts: { brokenMeminfo?: boolean } = {},
): string {
  device.brokenMeminfo = opts.brokenMeminfo === true;
  return runShell(device, splitStatements(command));
}

import type { FakeDevice } from './device';

/**
 * ⚠️ **The fake device** — it "executes" the commands of the sampler on a
 * virtual board.
 *
 * ── Why it has a little shell of its own ──
 *
 * Because **the commands the sampler uses to fetch data are shell commands**:
 *
 * ```
 * echo '<marker>'; cat -- '<path>'; echo '<separator>'; cat -- '<other path>'; echo '<marker>'
 * ```
 *
 * plus the `for d in <glob>; do printf …; done` of the thermal zone.
 *
 * ── Why the string cannot be cut at the markers ──
 *
 * Because the fragment of `proc_stat` **carries an echo of its own** (the
 * separator `--- cpuinfo ---`).
 * Cutting at the markers means **where the cut lands is a matter of luck**:
 * when the separator is taken for a marker, the kind reports a parse_error,
 * and **the cause is inside the fake device** and cannot be seen on the board —
 * that is **a fake board teaching the real code the wrong thing**.
 *
 * → So it **runs with shell semantics** here: `;` separates the statements,
 * the quotes wrap the arguments, `$( )` does the command substitution, and
 * `for … do … done` expands the glob.
 *
 * ── A statement that is not understood produces no output at all ──
 *
 * **No guessing**: the fake device would rather say "I do not know" than make
 * up a number.
 */

/** One word: the text + whether it was quoted (a quoted word is not substituted) */
interface Word {
  text: string;
  quoted: boolean;
}

/** Finds the `)` that matches the `(` at the position of `open` (the brackets inside the quotes are skipped) */
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
 * Reads one word wrapped in **double quotes**.
 *
 * A `$( )` may appear inside the double quotes (the command substitution is
 * evaluated as well), and **there may be quotes inside the command
 * substitution** —
 * `"$(cat -- "$d/type")"` is one of the most common shell idioms,
 * so this has to read **recursively**; it cannot simply "look for the next
 * `"`".
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
 * Splits one statement into words.
 *
 * - `'...'`: as it is (**no substitution at all**)
 * - `"..."`: as it is, but `$( )` is evaluated as well
 * - `$(...)`: a command substitution — **evaluated recursively**
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

/** Is it a redirection (`2>/dev/null`) or an option (`--`) — neither of them is a path */
function isNotAPath(word: Word): boolean {
  return word.text.startsWith('-') || word.text.includes('>');
}

/**
 * Runs one statement and returns what it printed.
 *
 * **A statement that is not understood → no output** (no guessing).
 */
function evalStatement(device: FakeDevice, statement: string): string {
  const words = splitWords(device, statement);
  if (words.length === 0) return '';
  const command = words[0]!.text;

  if (command === 'echo') {
    // A real `echo` joins the arguments with spaces
    return `${words.slice(1).map((w) => w.text).join(' ')}\n`;
  }

  if (command === 'cat') {
    const path = words.slice(1).find((w) => !isNotAPath(w));
    if (path === undefined) return '';
    // **The file does not exist → not a single character** (a real `cat` behaves the same way: the error goes to stderr)
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

  // **Not understood → nothing at all**
  return '';
}

/**
 * Splits the statements at `;` (a `;` inside the quotes or the brackets does
 * not count).
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
 * Runs a series of statements.
 *
 * `for <variable> in <glob>; do <body>; done` is **expanded**: the
 * `$variable` of the body is replaced with every item of the glob, and the
 * body is run once per item.
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
      // The body of the loop: from the `do` statement up to before the `done`
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

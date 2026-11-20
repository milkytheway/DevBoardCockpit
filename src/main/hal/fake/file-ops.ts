import type { ExecResult } from '../connection';
import type { VirtualFs } from './fs';

/**
 * ⚠️ **The fake device** — it recognises the "file commands".
 *
 * ── Why it is a module of its own ──
 *
 * The little shell in `fake/exec.ts` takes care of the **fetch commands of
 * the sampler** (`echo '<marker>'; cat -- '<path>'; …`) — those are
 * **multi-statement**, their output has to be cut at the markers, and **not
 * one character more**.
 *
 * The **commands of the actions** on the other hand are **single-statement**
 * (`echo 128 > /path`, `cat -- '/path'`, `test -s /path`,
 * `grep -qF 'x' /path`) — what they want is the **exit code** and the **side
 * effect**, not a piece of text.
 *
 * → The two are **separated**: here only the four single-statement file
 * commands are recognised; **when it is not recognised `null` is returned**
 * and the little shell takes over (**no guessing**).
 *
 * ── Why `cat` has to report an error when it cannot read (and not give an empty string) ──
 *
 * A real `cat` that cannot read the file → **exit code 1 + stderr**.
 * The fake device giving an empty string + exit code 0 → **"the readback does
 * not match" would be misread as "the value is empty"**, while the real error
 * is "the file does not exist at all".
 * → It behaves like a real `cat` here: **exit code 1 + stderr** ✓.
 */

/** What the file commands of the fake device need */
export interface FileCommandDeps {
  /** The virtual disk */
  fs: VirtualFs;
  /** The files the fake device **synthesises** (`/proc/stat` and the like) — they are looked up here when they are not on the disk */
  deviceRead: (path: string) => string | null;
}

/**
 * Recognises one command.
 *
 * @returns the result when it was recognised; **`null` when it was not**
 * (the little shell takes over).
 */
export function fakeFileCommand(command: string, deps: FileCommandDeps): ExecResult | null {
  const tokens = tokenize(command);
  if (tokens === null || tokens.length === 0) return null;
  const [head, ...rest] = tokens;

  if (head === 'cat') return catCommand(rest, deps);
  if (head === 'echo') return echoCommand(rest, deps);
  if (head === 'test') return testCommand(rest, deps);
  if (head === 'grep') return grepCommand(rest, deps);
  return null;
}

/** `cat -- <path>` (the `--` may be left out) */
function catCommand(args: string[], deps: FileCommandDeps): ExecResult | null {
  const path = args.find((a) => !a.startsWith('-'));
  if (path === undefined) return null;
  const content = readPath(path, deps);
  if (content === null) {
    return failure(1, `cat: ${path}: No such file or directory`);
  }
  return success(content);
}

/** `echo <value> > <path>` (without the `>` it is not a redirection → not recognised) */
function echoCommand(args: string[], deps: FileCommandDeps): ExecResult | null {
  const arrow = args.indexOf('>');
  if (arrow === -1) return null;
  const path = args[arrow + 1];
  if (path === undefined) return null;
  const value = args.slice(0, arrow).join(' ');
  deps.fs.write(path, value);
  // **A real `echo` with a redirection prints nothing**
  return success('');
}

/** `test -s <path>` (the file exists and is not empty → 0) */
function testCommand(args: string[], deps: FileCommandDeps): ExecResult | null {
  if (args[0] !== '-s') return null;
  const path = args[1];
  if (path === undefined) return null;
  const content = readPath(path, deps);
  const nonEmpty = content !== null && content.trim() !== '';
  return { exitCode: nonEmpty ? 0 : 1, stdout: '', stderr: '', durationMs: 1, timedOut: false };
}

/** `grep -qF <needle> <path>` (found → 0, not found → 1, the file is not there → 2) */
function grepCommand(args: string[], deps: FileCommandDeps): ExecResult | null {
  if (args[0] !== '-qF') return null;
  const needle = args[1];
  const path = args[2];
  if (needle === undefined || path === undefined) return null;
  const content = readPath(path, deps);
  if (content === null) {
    return failure(2, `grep: ${path}: No such file or directory`);
  }
  const found = content.includes(needle);
  return { exitCode: found ? 0 : 1, stdout: '', stderr: '', durationMs: 1, timedOut: false };
}

/** Reads one path: first the virtual disk, then the files the fake device synthesises */
function readPath(path: string, deps: FileCommandDeps): string | null {
  const onDisk = deps.fs.readText(path);
  if (onDisk !== null) return onDisk;
  return deps.deviceRead(path);
}

function success(stdout: string): ExecResult {
  return { exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false };
}

function failure(exitCode: number, stderr: string): ExecResult {
  return { exitCode, stdout: '', stderr, durationMs: 1, timedOut: false };
}

/**
 * Splits into words: single quotes (`'…'`, a `'` inside is written `'\''`),
 * double quotes, bare words.
 *
 * **As soon as the statement separator `;` shows up `null` is returned** —
 * that is a **multi-statement** command, and the little shell takes it (the
 * fetch commands of the sampler are of that kind).
 *
 * @returns `null` when a quote is not closed or when the command has several
 *          statements (**this command is not recognised**).
 */
function tokenize(command: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  while (i < command.length) {
    while (i < command.length && (command[i] === ' ' || command[i] === '\t')) i += 1;
    if (i >= command.length) break;
    const ch = command[i]!;

    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      let value = '';
      let closed = false;
      while (i < command.length) {
        // The `'\''` inside the single quotes = one literal single quote (the argument encoder escapes it exactly like this)
        if (quote === "'" && command.startsWith("'\\''", i)) {
          value += "'";
          i += 4;
          continue;
        }
        if (command[i] === quote) {
          i += 1;
          closed = true;
          break;
        }
        value += command[i];
        i += 1;
      }
      if (!closed) return null;
      tokens.push(value);
      continue;
    }

    // A bare word: **`>` is a word of its own** (`echo 1 > /p` and `echo 1> /p` both have to be recognised)
    let value = '';
    while (i < command.length && command[i] !== ' ' && command[i] !== '\t') {
      if (command[i] === '>') break;
      // **`;` is the statement separator** → this is a multi-statement command → the little shell takes it
      if (command[i] === ';') return null;
      value += command[i];
      i += 1;
    }
    if (value !== '') tokens.push(value);
    if (i < command.length && command[i] === '>') {
      tokens.push('>');
      i += 1;
    }
  }
  return tokens;
}

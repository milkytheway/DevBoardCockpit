import type { ExecResult } from '../connection';
import type { VirtualFs } from './fs';

/**
 * ⚠️ **假设备** —— 认「文件命令」。
 *
 * ── 为什么单独一个模块 ──
 *
 * `fake/exec.ts` 里的小 shell 负责**采样器的取数命令**
 * （`echo '<marker>'; cat -- '<路径>'; …`）——那是**多语句**的，
 * 它的输出要按 marker 切，**一个字都不能多**。
 *
 * 而**动作的命令**是**单语句**的（`echo 128 > /path`、`cat -- '/path'`、
 * `test -s /path`、`grep -qF 'x' /path`）——
 * 它们要的是**退出码**与**副作用**，不是一段文本。
 *
 * → 两者**分开**：这里只认**单语句**的四种文件命令；
 * **认不出来就返回 `null`**，交回小 shell（**不猜**）。
 *
 * ── 为什么 `cat` 读不到时要报错（而不是给空串）──
 *
 * 真 `cat` 读不到文件 → **退出码 1 + stderr**。
 * 假设备给空串 + 退出码 0 → **「回读不符」会被误读成「值是空的」**，
 * 而真正的错是「文件根本不存在」。
 * → 这里照真 cat：**退出码 1 + stderr** ✓。
 */

/** 假设备的文件命令需要什么 */
export interface FileCommandDeps {
  /** 虚拟盘 */
  fs: VirtualFs;
  /** 假设备**合成**的那些文件（`/proc/stat` 等）——盘上没有时看这里 */
  deviceRead: (path: string) => string | null;
}

/**
 * 认一条命令。
 *
 * @returns 认出来了就返回结果；**认不出来返回 `null`**（交给小 shell）。
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

/** `cat -- <path>`（`--` 可省） */
function catCommand(args: string[], deps: FileCommandDeps): ExecResult | null {
  const path = args.find((a) => !a.startsWith('-'));
  if (path === undefined) return null;
  const content = readPath(path, deps);
  if (content === null) {
    return failure(1, `cat: ${path}: No such file or directory`);
  }
  return success(content);
}

/** `echo <值> > <路径>`（没有 `>` 就不是重定向 → 不认） */
function echoCommand(args: string[], deps: FileCommandDeps): ExecResult | null {
  const arrow = args.indexOf('>');
  if (arrow === -1) return null;
  const path = args[arrow + 1];
  if (path === undefined) return null;
  const value = args.slice(0, arrow).join(' ');
  deps.fs.write(path, value);
  // **真 `echo` 带重定向时不打印任何东西**
  return success('');
}

/** `test -s <路径>`（文件存在且非空 → 0） */
function testCommand(args: string[], deps: FileCommandDeps): ExecResult | null {
  if (args[0] !== '-s') return null;
  const path = args[1];
  if (path === undefined) return null;
  const content = readPath(path, deps);
  const nonEmpty = content !== null && content.trim() !== '';
  return { exitCode: nonEmpty ? 0 : 1, stdout: '', stderr: '', durationMs: 1, timedOut: false };
}

/** `grep -qF <needle> <路径>`（找到 → 0，没找到 → 1，文件不在 → 2） */
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

/** 读一个路径：先看虚拟盘，再看假设备合成的那些文件 */
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
 * 切词：单引号（`'…'`，内部 `'` 写成 `'\''`）、双引号、裸词。
 *
 * **见到语句分隔符 `;` 就返回 `null`**——那是**多语句**的命令，
 * 归小 shell 管（采样器的取数命令就是这种）。
 *
 * @returns 引号没闭合、或命令是多语句的，就返回 `null`（**不认这条命令**）。
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
        // 单引号里的 `'\''` = 一个字面的单引号（参数编码器就是这么转义的）
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

    // 裸词：**`>` 单独成词**（`echo 1 > /p` 与 `echo 1> /p` 都要认）
    let value = '';
    while (i < command.length && command[i] !== ' ' && command[i] !== '\t') {
      if (command[i] === '>') break;
      // **`;` 是语句分隔符** → 这是多语句命令 → 归小 shell
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

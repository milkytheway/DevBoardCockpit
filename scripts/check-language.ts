/**
 * The language gate.
 *
 * The repository is written in English. This script is the verdict that keeps
 * it that way: a Chinese character in a source comment is a defect, and a
 * Chinese character in a string literal is a defect unless the literal is the
 * `zh-Hans` half of a localised pair.
 *
 * ── Why it has to be a script and not a convention ──
 *
 * A convention decays. The interface has a language switch, so the Chinese
 * strings have to stay in the renderer, and a rule that says "no Chinese
 * except the Chinese locale" cannot be checked by reading. This script is
 * that check.
 *
 * ── How the comments are found ──
 *
 * The comments are collected with the TypeScript scanner rather than by
 * walking the syntax tree. The tree does not visit a standalone `//`
 * comment, and it only reaches a documentation block through the node it
 * is attached to; the scanner sees every comment in the file, whatever it is
 * attached to. An earlier version of this script walked the tree and
 * therefore missed every standalone comment.
 *
 * ── What is allowed ──
 *
 *   1. The `zh-Hans` value of a localised pair. That is the whole point of
 *      having a language switch.
 *   2. A comment that mentions the Chinese locale. The one place a comment
 *      has to show a Chinese string is the example that documents a
 *      localised pair.
 *   3. A test that pins the Chinese locale. It asserts Chinese text on
 *      purpose.
 *   4. The files listed in `ALLOWED_FILES`. They are the Chinese front door
 *      of the repository and they are Chinese on purpose.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extname, join } from 'node:path';
import ts from 'typescript';

/**
 * Files that are Chinese on purpose.
 *
 * The README is the Chinese front door; the tutorial has a Chinese edition;
 * the glossary is bilingual because it maps the Chinese terms to the English
 * ones.
 */
const ALLOWED_FILES = new Set([
  'README.md',
  // The only Chinese in the English README is the link label of the Chinese edition.
  'README.en.md',
  'docs/tutorial/01-build-a-board-pack.zh-Hans.md',
  'docs/tutorial/02-terminology-glossary.md',
]);

const CJK = /[\u4e00-\u9fff]/;

/**
 * A comment may mention the Chinese locale: the one place a comment has to
 * show a Chinese string is the example that documents a localised pair.
 */
const COMMENT_ALLOWED = /['"`]zh-Hans['"`]/;

/**
 * The Chinese literals that have to stay.
 *
 * They are test vectors, not prose:
 *
 *   - a multi-byte character has to be cut in the middle of a byte stream and
 *     a wide character has to measure two columns, so the vector cannot be
 *     ASCII;
 *   - a label that comes out of a golden vector has to come back unchanged,
 *     and the golden vectors are append-only.
 *
 * The list is of exact literals, not of files: a file that is on this list
 * is still guarded for everything else it contains.
 */
const ALLOWED_LITERALS = new Set([
  '中',
  '文',
  '中文',
  '中文abc',
  'echo 中文',
  '错误',
  '板子 · 串口',
  '--- connected 板子 · 串口 ---',
  '=== session opened 2026-11-12 02:15:07 target=板子 · 串口 transport=serial ===',
  '我的板子',
]);

interface Finding {
  file: string;
  line: number;
  kind: string;
  text: string;
}

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files'], { encoding: 'utf8' });
  return out.split('\n').filter((f) => f.length > 0);
}

function scriptKind(ext: string): ts.ScriptKind {
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

/** The Chinese characters of a text, with the rest of the line kept short. */
function excerpt(text: string): string {
  const first = text.split('\n').find((l) => CJK.test(l)) ?? text;
  return first.trim().slice(0, 90);
}

/**
 * The comments of a file, with the positions that are really comments.
 *
 * The scanner alone is not enough. It reports a "//" inside the children of
 * a JSX element as a comment, while the syntax tree says it is text: that
 * text is rendered, and an agent that "translated" it would change what the
 * user sees.
 *
 * So the comments are collected from the token tree instead. Every token
 * knows the comment ranges in front of it and the comment ranges behind it,
 * and those are exactly the comments. The scanner is kept as a second
 * opinion: whatever it finds that the token tree does not know is reported
 * unless it falls inside a JSX text region.
 */
function scanComments(
  source: string,
  sf: ts.SourceFile,
  lineOf: (pos: number) => number,
): Finding[] {
  const findings: Finding[] = [];
  const known = new Set<number>();
  const ranges: ts.CommentRange[] = [];

  const collect = (list: ts.CommentRange[] | undefined): void => {
    if (!list) return;
    for (const range of list) {
      if (known.has(range.pos)) continue;
      known.add(range.pos);
      ranges.push(range);
    }
  };

  const visitTokens = (node: ts.Node): void => {
    for (const child of node.getChildren(sf)) {
      collect(ts.getLeadingCommentRanges(source, child.getFullStart()));
      collect(ts.getTrailingCommentRanges(source, child.getEnd()));
      visitTokens(child);
    }
  };
  visitTokens(sf);

  const jsxTextRanges: ts.CommentRange[] = [];
  const collectJsxText = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      jsxTextRanges.push({ pos: node.getStart(sf), end: node.getEnd() });
    }
    ts.forEachChild(node, collectJsxText);
  };
  collectJsxText(sf);

  const insideJsxText = (pos: number): boolean =>
    jsxTextRanges.some((r) => pos >= r.pos && pos < r.end);

  const report = (pos: number, text: string): void => {
    if (!CJK.test(text) || COMMENT_ALLOWED.test(text)) return;
    findings.push({ file: '', line: lineOf(pos), kind: 'comment', text: excerpt(text) });
  };

  for (const range of ranges) {
    // A range that falls inside a JSX text region is rendered text, not a comment.
    if (insideJsxText(range.pos)) continue;
    report(range.pos, source.slice(range.pos, range.end));
  }

  // The second opinion: anything the scanner sees that the token tree does
  // not know is a comment unless it sits in JSX text.
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    sf.languageVariant,
    source,
  );
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (
      kind !== ts.SyntaxKind.SingleLineCommentTrivia &&
      kind !== ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      continue;
    }
    const pos = scanner.getTokenPos();
    if (known.has(pos)) continue;
    if (insideJsxText(pos)) continue;
    report(pos, scanner.getTokenText());
  }

  return findings;
}

function scanScript(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  const ext = extname(file);
  // A test that pins the Chinese locale asserts Chinese text on purpose.
  const localePinned = file.startsWith('tests/') && /zh-Hans/.test(source);
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(ext));
  } catch {
    return findings;
  }
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

  for (const finding of scanComments(source, sf, lineOf)) {
    findings.push({ ...finding, file });
  }

  const visit = (node: ts.Node): void => {
    // A localised pair: the `zh-Hans` half may contain Chinese.
    if (ts.isPropertyAssignment(node)) {
      const name = node.name.getText(sf);
      if (name === "'zh-Hans'" || name === '"zh-Hans"' || name === '`zh-Hans`') {
        ts.forEachChild(node.name, visit);
        return;
      }
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const text = node.getText(sf);
      const value = (node as ts.StringLiteralLike).text ?? '';
      if (CJK.test(text) && !localePinned && !ALLOWED_LITERALS.has(value)) {
        findings.push({ file, line: lineOf(node.getStart(sf)), kind: 'string', text: excerpt(text) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

function scanText(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (CJK.test(lines[i])) {
      findings.push({ file, line: i + 1, kind: 'text', text: lines[i].trim().slice(0, 90) });
    }
  }
  return findings;
}

function main(): void {
  const findings: Finding[] = [];
  for (const file of trackedFiles()) {
    if (ALLOWED_FILES.has(file)) continue;
    let source: string;
    try {
      source = readFileSync(join(process.cwd(), file), 'utf8');
    } catch {
      continue;
    }
    const ext = extname(file);
    if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      findings.push(...scanScript(file, source));
    } else if (
      ext === '.md' ||
      ext === '.json' ||
      ext === '.yaml' ||
      ext === '.yml' ||
      ext === '.css' ||
      ext === '.html'
    ) {
      findings.push(...scanText(file, source));
    }
  }

  if (findings.length === 0) {
    console.log('language gate: no Chinese outside the zh-Hans locale and the allowed files');
    return;
  }

  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file)!.push(f);
  }
  for (const [file, list] of byFile) {
    console.error(`${file} (${list.length})`);
    for (const f of list.slice(0, 6)) {
      console.error(`  ${f.line}: ${f.kind}: ${f.text}`);
    }
    if (list.length > 6) console.error(`  ... and ${list.length - 6} more`);
  }
  console.error(`\nlanguage gate: ${findings.length} findings in ${byFile.size} files`);
  process.exitCode = 1;
}

main();
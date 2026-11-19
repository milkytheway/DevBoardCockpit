/**
 * 词表生成器。
 *
 * `docs/spec/data/tag-vocabulary.yaml` 是核心词表的**唯一权威**
 * （`docs/spec/01-tag-contract.md` §一）。本脚本从它生成两样东西：
 *
 *   1. `docs/spec/01-tag-contract.md` 里那张 Markdown 表格（人类可读渲染）
 *   2. `src/shared/generated/tag-vocabulary.generated.ts`（实现层用的机器可读形态）
 *
 * **为什么要有它**：`docs/04-架构设计.md` §4.3 把它叫「语义不漂移的唯一硬判据」，
 * `AGENTS.md` 叫「对拍是硬判据」。判据必须能自动跑，否则只是口号。
 * 有了这个脚本，`--check` 就能回答一个具体问题：
 * 「YAML、文档表格、代码词表这三份，现在还一致吗？」
 *
 * 用法：
 *   npx tsx scripts/gen-vocabulary.ts          # 生成
 *   npx tsx scripts/gen-vocabulary.ts --check  # 只检查，不一致就退出码 1
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ── 类型 ──────────────────────────────────────────────────────────────

export type TagType = 'number' | 'string' | 'boolean' | 'enum';
export type V1Status = 'required' | 'reserved';

export interface VocabularyEntry {
  pattern: string;
  type: TagType;
  unit: string;
  /** 数组表示区间 [min, max]；字符串表示其他取值域（开放枚举等） */
  range: [number, number] | string;
  semantics: string;
  v1: V1Status;
}

/** YAML 里 range 的原始形态 */
type RawRange = string | [number, number];

interface RawEntry {
  pattern?: unknown;
  type?: unknown;
  unit?: unknown;
  range?: RawRange;
  semantics?: unknown;
  v1?: unknown;
}

// ── 极简 YAML 读取 ────────────────────────────────────────────────────
//
// 词表 YAML 的形状是固定的（`entries:` 下每项 5 个键，值都是标量或两元素数组），
// 所以不引 YAML 库——引了就要多一个依赖，而这里的语法面小到可以手写解析。
// **只认这一种形状**；形状不对就报错，不猜。

function parseScalar(text: string): unknown {
  const t = text.trim();
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d*\.\d+$/.test(t)) return Number(t);
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return inner.split(',').map((p) => parseScalar(p));
  }
  return t;
}

/** 往条目里塞一个字段。范围字段的值可能是数组，其余是标量。 */
function setField(entry: Partial<RawEntry>, key: string, raw: string): void {
  const value: unknown = raw.trim() === '' ? '' : parseScalar(raw);
  if (key === 'range') {
    entry.range = value as RawRange;
  } else {
    (entry as Record<string, unknown>)[key] = value;
  }
}

function parseVocabularyYaml(text: string): VocabularyEntry[] {
  const lines = text.split(/\r?\n/);
  const entries: VocabularyEntry[] = [];
  let current: Partial<RawEntry> | undefined;
  let inEntries = false;

  const flush = (): void => {
    if (current && current.pattern !== undefined) {
      entries.push(current as RawEntry as VocabularyEntry);
    }
    current = undefined;
  };

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    if (line.trim().length === 0 || line.trim().startsWith('#')) continue;

    if (/^entries:\s*$/.test(line)) {
      inEntries = true;
      continue;
    }
    if (!inEntries) continue;

    const item = /^\s*-\s+(\w+):\s*(.*)$/.exec(line);
    if (item) {
      flush();
      current = {};
      const [, key, value] = item;
      setField(current, key, value);
      continue;
    }

    const field = /^\s+(\w+):\s*(.*)$/.exec(line);
    if (field && current) {
      const [, key, value] = field;
      setField(current, key, value);
    }
  }
  flush();

  return entries.map((e, i) => {
    if (typeof e.pattern !== 'string') throw new Error(`第 ${i + 1} 条缺 pattern`);
    if (!['number', 'string', 'boolean', 'enum'].includes(String(e.type))) {
      throw new Error(`第 ${i + 1} 条（${e.pattern}）的 type 非法：${String(e.type)}`);
    }
    if (!['required', 'reserved'].includes(String(e.v1))) {
      throw new Error(`第 ${i + 1} 条（${e.pattern}）的 v1 非法：${String(e.v1)}`);
    }
    return {
      pattern: e.pattern,
      type: e.type as TagType,
      unit: String(e.unit ?? '-'),
      range: (e.range ?? '-') as [number, number] | string,
      semantics: String(e.semantics ?? ''),
      v1: e.v1 as V1Status,
    };
  });
}

/** 读词表 YAML */
export function loadVocabulary(path: string): VocabularyEntry[] {
  return parseVocabularyYaml(readFileSync(path, 'utf8'));
}

// ── 渲染 ──────────────────────────────────────────────────────────────

function rangeText(range: [number, number] | string): string {
  // 数组渲染成 `[0,100]`（紧凑，与文档表格一致）
  if (Array.isArray(range)) return `[${range.join(',')}]`;
  return range;
}

/** 渲染成 `docs/spec/01` 里那张 Markdown 表格 */
export function renderMarkdownTable(entries: VocabularyEntry[]): string {
  const header = '| 模式 | 类型 | 单位 | 取值域 | 语义 | v1 |';
  const sep = '|---|---|---|---|---|---|';
  const rows = entries.map(
    (e) =>
      `| \`${e.pattern}\` | ${e.type} | ${e.unit} | ${rangeText(e.range)} | ${e.semantics} | ${e.v1} |`,
  );
  return [header, sep, ...rows].join('\n');
}

/** 解析文档里已有的那张表格（用来跟 YAML 对拍） */
export function parseMarkdownTable(doc: string): Array<{
  pattern: string;
  type: string;
  unit: string;
  range: string;
  semantics: string;
  v1: string;
}> {
  const out: Array<{
    pattern: string;
    type: string;
    unit: string;
    range: string;
    semantics: string;
    v1: string;
  }> = [];
  for (const line of doc.split(/\r?\n/)) {
    const m = /^\|\s*`([^`]+)`\s*\|\s*(\w+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*(\w+)\s*\|$/.exec(
      line,
    );
    if (!m) continue;
    out.push({
      pattern: m[1],
      type: m[2],
      unit: m[3],
      range: m[4],
      semantics: m[5],
      v1: m[6],
    });
  }
  return out;
}

/** 渲染成实现层用的 TypeScript */
export function renderTypeScript(entries: VocabularyEntry[]): string {
  const names = entries.map((e) => `  '${e.pattern}'`).join(' |\n');
  const rows = entries
    .map(
      (e) =>
        `  {
    pattern: '${e.pattern}',
    type: '${e.type}',
    unit: '${e.unit}',
    range: ${JSON.stringify(e.range)},
    semantics: ${JSON.stringify(e.semantics)},
    v1: '${e.v1}',
  },`,
    )
    .join('\n');

  return `// Generated by scripts/gen-vocabulary.ts — do not edit by hand.
// Source: docs/spec/data/tag-vocabulary.yaml (the single source of truth
// for the core vocabulary).
// Regenerate: npm run gen:vocabulary
// Check consistency: npm run gen:vocabulary -- --check

export type TagType = 'number' | 'string' | 'boolean' | 'enum';
export type V1Status = 'required' | 'reserved';

export interface CoreTagEntry {
  pattern: string;
  type: TagType;
  unit: string;
  range: [number, number] | string;
  semantics: string;
  v1: V1Status;
}

/** The machine-readable form of the core vocabulary. The validator, the runtime and describe_tag share this one copy. */
export const CORE_VOCABULARY: readonly CoreTagEntry[] = [
${rows}
];

/** The union type of the core tag names */
export type CoreTagName =
${names};
`;
}

// ── 命令行 ────────────────────────────────────────────────────────────

interface Paths {
  yaml: string;
  doc: string;
  ts: string;
}

function defaultPaths(root: string): Paths {
  return {
    yaml: join(root, 'docs/spec/data/tag-vocabulary.yaml'),
    doc: join(root, 'docs/spec/01-tag-contract.md'),
    ts: join(root, 'src/shared/generated/tag-vocabulary.generated.ts'),
  };
}

/** 把渲染出来的表格替换进文档里的那一段 */
export function replaceTableInDoc(doc: string, table: string): string {
  const header = '| 模式 | 类型 | 单位 | 取值域 | 语义 | v1 |';
  const start = doc.indexOf(header);
  if (start < 0) throw new Error('文档里找不到词表表格');
  const lines = doc.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.startsWith(header));
  if (idx < 0) throw new Error('文档里找不到词表表格');
  // 表格 = 表头 + 分隔行 + N 行数据
  let end = idx;
  while (end < lines.length && lines[end].trim().startsWith('|')) end += 1;
  const newLines = [...lines.slice(0, idx), ...table.split('\n'), ...lines.slice(end)];
  return newLines.join('\n');
}

function main(): void {
  const root = process.cwd();
  const paths = defaultPaths(root);
  const check = process.argv.includes('--check');

  const entries = loadVocabulary(paths.yaml);
  const table = renderMarkdownTable(entries);
  const ts = renderTypeScript(entries);

  const doc = readFileSync(paths.doc, 'utf8');
  const docTable = parseMarkdownTable(doc);
  const yamlTable = entries.map((e) => ({
    pattern: e.pattern,
    type: e.type,
    unit: e.unit,
    range: rangeText(e.range),
    semantics: e.semantics,
    v1: e.v1,
  }));

  const problems: string[] = [];
  if (JSON.stringify(docTable) !== JSON.stringify(yamlTable)) {
    problems.push('docs/spec/01 的表格与 YAML 不一致');
  }

  let existingTs = '';
  if (existsSync(paths.ts)) existingTs = readFileSync(paths.ts, 'utf8');
  if (existingTs !== ts) {
    problems.push(`${paths.ts} 与 YAML 不一致`);
  }

  if (check) {
    if (problems.length > 0) {
      console.error('✗ 词表三份不一致：');
      for (const p of problems) console.error(`  - ${p}`);
      console.error('  跑 npm run gen:vocabulary 重新生成。');
      process.exit(1);
    }
    console.log(`✓ 词表三份一致：YAML（${entries.length} 条）= 文档表格 = 代码词表`);
    return;
  }

  writeFileSync(paths.doc, replaceTableInDoc(doc, table), 'utf8');
  mkdirSync(dirname(paths.ts), { recursive: true });
  writeFileSync(paths.ts, ts, 'utf8');
  console.log(`已生成：${paths.doc}（表格）与 ${paths.ts}（${entries.length} 条）`);
}

// 直接运行时才执行 CLI；被 import 时只导出函数
if (process.argv[1] && process.argv[1].endsWith('gen-vocabulary.ts')) {
  main();
}

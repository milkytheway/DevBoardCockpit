/**
 * The generator of the vocabulary.
 *
 * `docs/spec/data/tag-vocabulary.yaml` is the **only authority** of the core
 * vocabulary (`docs/spec/01-tag-contract.md` §1). This script generates two
 * things from it:
 *
 *   1. the Markdown table in `docs/spec/01-tag-contract.md` (the rendering
 *      for a human)
 *   2. `src/shared/generated/tag-vocabulary.generated.ts` (the machine
 *      readable shape that the implementation layer uses)
 *
 * **Why it exists**: the architecture of the project calls it "the only hard
 * criterion that keeps the semantics from drifting", and `AGENTS.md` calls it
 * "comparing the two is a hard criterion". A criterion has to be able to run
 * on its own, otherwise it is only a slogan.
 * With this script `--check` can answer one concrete question:
 * "are the YAML, the table of the document and the vocabulary of the code still
 * the same?"
 *
 * Usage:
 *   npx tsx scripts/gen-vocabulary.ts          # generate
 *   npx tsx scripts/gen-vocabulary.ts --check  # only check, exit code 1 when it differs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ── The types ────────────────────────────────────────────────────────

export type TagType = 'number' | 'string' | 'boolean' | 'enum';
export type V1Status = 'required' | 'reserved';

export interface VocabularyEntry {
  pattern: string;
  type: TagType;
  unit: string;
  /** An array is the range [min, max]; a string is any other domain (an open enumeration and the like) */
  range: [number, number] | string;
  semantics: string;
  v1: V1Status;
}

/** The raw shape of the range in the YAML */
type RawRange = string | [number, number];

interface RawEntry {
  pattern?: unknown;
  type?: unknown;
  unit?: unknown;
  range?: RawRange;
  semantics?: unknown;
  v1?: unknown;
}

// ── A minimal YAML reader ────────────────────────────────────────────
//
// The shape of the vocabulary YAML is fixed (under `entries:` every item has
// 5 keys, the values are scalars or arrays of two), so no YAML library is
// pulled in — that would be one dependency more, while the syntax that is
// needed here is small enough to be parsed by hand.
// **Only this one shape is accepted**; a different shape is an error, nothing
// is guessed.

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

/** Puts one field into an entry. The value of the range field may be an array, the other ones are scalars. */
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
    if (typeof e.pattern !== 'string') throw new Error(`entry ${i + 1} has no pattern`);
    if (!['number', 'string', 'boolean', 'enum'].includes(String(e.type))) {
      throw new Error(`the type of entry ${i + 1} (${e.pattern}) is not valid: ${String(e.type)}`);
    }
    if (!['required', 'reserved'].includes(String(e.v1))) {
      throw new Error(`the v1 of entry ${i + 1} (${e.pattern}) is not valid: ${String(e.v1)}`);
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

/** Reads the vocabulary YAML */
export function loadVocabulary(path: string): VocabularyEntry[] {
  return parseVocabularyYaml(readFileSync(path, 'utf8'));
}

// ── The rendering ─────────────────────────────────────────────────────

function rangeText(range: [number, number] | string): string {
  // An array is rendered as `[0,100]` (compact, like the table of the document)
  if (Array.isArray(range)) return `[${range.join(',')}]`;
  return range;
}

/** Renders the Markdown table of `docs/spec/01` */
export function renderMarkdownTable(entries: VocabularyEntry[]): string {
  const header = '| Pattern | Type | Unit | Range | Semantics | v1 |';
  const sep = '|---|---|---|---|---|---|';
  const rows = entries.map(
    (e) =>
      `| \`${e.pattern}\` | ${e.type} | ${e.unit} | ${rangeText(e.range)} | ${e.semantics} | ${e.v1} |`,
  );
  return [header, sep, ...rows].join('\n');
}

/** Parses the table that the document already has (to compare it with the YAML) */
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

/** Renders the TypeScript that the implementation layer uses */
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

// ── The command line ─────────────────────────────────────────────────

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

/** Replaces the section of the document with the rendered table */
export function replaceTableInDoc(doc: string, table: string): string {
  const header = '| Pattern | Type | Unit | Range | Semantics | v1 |';
  const start = doc.indexOf(header);
  if (start < 0) throw new Error('the vocabulary table was not found in the document');
  const lines = doc.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.startsWith(header));
  if (idx < 0) throw new Error('the vocabulary table was not found in the document');
  // the table = the header + the separator + N rows of data
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
    problems.push('the table of docs/spec/01 and the YAML differ');
  }

  let existingTs = '';
  if (existsSync(paths.ts)) existingTs = readFileSync(paths.ts, 'utf8');
  if (existingTs !== ts) {
    problems.push(`${paths.ts} and the YAML differ`);
  }

  if (check) {
    if (problems.length > 0) {
      console.error('✗ the three copies of the vocabulary differ:');
      for (const p of problems) console.error(`  - ${p}`);
      console.error('  Run npm run gen:vocabulary to generate them again.');
      process.exit(1);
    }
    console.log(`✓ the three copies of the vocabulary are the same: the YAML (${entries.length} entries) = the table of the document = the vocabulary of the code`);
    return;
  }

  writeFileSync(paths.doc, replaceTableInDoc(doc, table), 'utf8');
  mkdirSync(dirname(paths.ts), { recursive: true });
  writeFileSync(paths.ts, ts, 'utf8');
  console.log(`generated: ${paths.doc} (the table) and ${paths.ts} (${entries.length} entries)`);
}

// The CLI only runs when it is run directly; when it is imported it only exports the functions
if (process.argv[1] && process.argv[1].endsWith('gen-vocabulary.ts')) {
  main();
}

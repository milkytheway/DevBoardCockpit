/**
 * **The link gate** (`npm run check:links`).
 *
 * ── What it guards ──
 *
 * The contract layer is the document an agent reads. A reference it cannot
 * follow is worse than no reference at all, and a sentence that is quietly
 * false is worse still.
 *
 * | Rule | What it finds |
 * |---|---|
 * | **R1** | a pointer outside this repository (`ADR-D…`, "the implementation-layer decision record") — the decision record is not published, so those are dead ends for every reader |
 * | **R2** | a cross-file section reference that does not exist (`\`04\` section 2.4` → there is no such section) |
 * | **R3** | the same section number twice in one file (the reference then means two things) |
 * | **R4** | the same heading twice in one file (the reader does not know which one) |
 * | **R5** | a repository path in backticks that does not exist |
 * | **R6** | a line-number reference (`spec/04:123`) — the lines move, the section numbers do not |
 * | **R7** | a wording that ADR-D46 / ADR-D48 already overturned |
 *
 * ── Why it is self-contained ──
 *
 * → It must run in two places: **CI** (node 20 ✓) and **the sandbox**
 *   (`node --experimental-strip-types` ✓ — node 22.6+ only ✓).
 * → A relative import of a local `.ts` file without the extension breaks the
 *   second one (`ERR_MODULE_NOT_FOUND` ✓) → **so it imports nothing local** ✓
 *   (only `node:*` ✓) — the same shape as `check-language.ts` ✓.
 * → **No `enum`, no `namespace`, no parameter properties** ✓ (the type
 *   stripping cannot erase those ✓) → `as const` objects instead ✓.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** The contract layer (the machine-readable vocabulary lives in it too ✓) */
const SPEC_DIR = 'docs/spec';
const REPO = process.cwd();

/** The file names of the contract layer, by their short number */
const FILES: Record<string, string> = {
  '00': '00-overview.md',
  '01': '01-tag-contract.md',
  '02': '02-board-pack.md',
  '03': '03-card-manifest.md',
  '04': '04-mcp-tools.md',
  '05': '05-workflow-pack.md',
};

/**
 * The wordings ADR-D46 / ADR-D48 already overturned.
 *
 * → **Narrow on purpose** ✓: a historical sentence ("a destructive action
 *   *used to* require a human nod") is not a defect ✓ — only a sentence that
 *   states the overturned behaviour as the present one is ✓.
 */
const OVERTURNED = [
  'a second confirmation',
  'needs a human confirmation',
  'asked once when the card is installed',
  'ask once per action',
  'the confirmation of a human',
];

/** The pointers that leave this repository */
const OUTSIDE = [
  /ADR-D\d+/,
  /implementation-layer decision record/,
  /of the implementation-layer/,
];

interface Finding {
  file: string;
  line: number;
  rule: string;
  text: string;
}

function readLines(rel: string): string[] {
  return readFileSync(join(REPO, rel), 'utf8').split(/\r?\n/);
}

/** The contract files (the markdown ones ✓ and the vocabulary ✓) */
function contractFiles(): string[] {
  const out: string[] = [];
  for (const name of Object.values(FILES)) {
    const rel = join(SPEC_DIR, name);
    if (existsSync(join(REPO, rel))) out.push(rel);
  }
  const dataDir = join(SPEC_DIR, 'data');
  if (existsSync(join(REPO, dataDir))) {
    for (const entry of readdirSync(join(REPO, dataDir))) {
      if (entry.endsWith('.yaml') || entry.endsWith('.yml')) out.push(join(dataDir, entry));
    }
  }
  return out;
}

/** The heading number → the heading text */
interface Heading {
  number: string;
  title: string;
  supplement: boolean;
  line: number;
}

function headings(lines: string[]): Heading[] {
  const out: Heading[] = [];
  let inFence = false;
  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    // → **a letter may follow the number** ✓ (`### 8.A` ✓ is a sub-table ✓ —
    //   **it is not the number 8** ✓ — so it must not collide with `## 8.` ✓)
    const m = /^#{2,4}\s+(\d+(?:\.\d+)*(?:\.[A-Za-z]+)*)\s*(.*)$/.exec(line);
    if (m === null) return;
    const title = (m[2] ?? '').trim();
    out.push({ number: m[1] ?? '', title, supplement: /^supplement\b/i.test(title), line: index + 1 });
  });
  return out;
}

function main(): void {
  const findings: Finding[] = [];
  const files = contractFiles();

  // ── The section numbers of every file ─────────────────────────────
  const byFile = new Map<string, Set<string>>();
  const headingsOf = new Map<string, Heading[]>();
  for (const rel of files) {
    const hs = headings(readLines(rel));
    headingsOf.set(rel, hs);
    const set = new Set<string>();
    for (const h of hs) {
      // **a supplement is a continuation** ✓ (5.5 and "5.5 supplement" are one family ✓)
      if (!h.supplement) set.add(h.number);
    }
    byFile.set(rel, set);
  }

  for (const rel of files) {
    const lines = readLines(rel);

    // ── R3 / R4 · the same number or the same title twice ──────────
    const seenNumbers = new Map<string, number>();
    const seenTitles = new Map<string, number>();
    for (const h of headingsOf.get(rel) ?? []) {
      if (!h.supplement) {
        const first = seenNumbers.get(h.number);
        if (first !== undefined) {
          findings.push({
            file: rel,
            line: h.line,
            rule: 'R3',
            text: `the section number ${h.number} is used twice in this file (the first one is at line ${first}) — a reference to it is ambiguous`,
          });
        } else {
          seenNumbers.set(h.number, h.line);
        }
      }
      const titleKey = h.title.toLowerCase();
      const firstTitle = seenTitles.get(titleKey);
      if (firstTitle !== undefined) {
        findings.push({
          file: rel,
          line: h.line,
          rule: 'R4',
          text: `the heading "${h.title}" appears twice in this file (the first one is at line ${firstTitle}) — the reader does not know which one`,
        });
      } else {
        seenTitles.set(titleKey, h.line);
      }
    }

    lines.forEach((line, index) => {
      const at = index + 1;
      // ── R1 · a pointer outside this repository ───────────────────
      for (const pattern of OUTSIDE) {
        if (pattern.test(line)) {
          findings.push({
            file: rel,
            line: at,
            rule: 'R1',
            text: `points outside this repository (${String(pattern)}) — the decision record is not published here`,
          });
        }
      }
      // ── R6 · a line-number reference ─────────────────────────────
      if (/spec\/0\d:\d+/.test(line)) {
        findings.push({
          file: rel,
          line: at,
          rule: 'R6',
          text: 'references a line number — the lines move, the section numbers do not',
        });
      }
      // ── R7 · a wording that was already overturned ────────────────
      for (const wording of OVERTURNED) {
        if (line.includes(wording)) {
          findings.push({
            file: rel,
            line: at,
            rule: 'R7',
            text: `still states the overturned wording "${wording}"`,
          });
        }
      }
      // ── R5 · a repository path that does not exist ────────────────
      for (const m of line.matchAll(/`((?:docs|src|scripts|tests|profiles|fixtures|cards)\/[^`\s]+)`/g)) {
        const path = m[1] ?? '';
        if (path.includes('*')) continue;
        // → **a placeholder is not a path** ✓ (`cards/<card-id>/storage.json` ✓)
        if (path.includes('<')) continue;
        if (!existsSync(join(REPO, path))) {
          findings.push({
            file: rel,
            line: at,
            rule: 'R5',
            text: `the path "${path}" does not exist in this repository`,
          });
        }
      }
      // ── R2 · a cross-file section reference that does not exist ───
      // → "`04` section 2.4" ✓ · "section 2.4 of `04`" ✓
      for (const m of line.matchAll(/`(0[0-5])`\s*section\s+(\d+(?:\.\d+)*)/g)) {
        const target = FILES[m[1] ?? ''];
        const number = m[2] ?? '';
        const set = byFile.get(join(SPEC_DIR, target)) ?? new Set<string>();
        if (!set.has(number)) {
          findings.push({
            file: rel,
            line: at,
            rule: 'R2',
            text: `the reference to \`${m[1]}\` section ${number} points at a section that does not exist`,
          });
        }
      }
      for (const m of line.matchAll(/section\s+(\d+(?:\.\d+)*)\s+of\s+`(0[0-5])`/g)) {
        const number = m[1] ?? '';
        const target = FILES[m[2] ?? ''];
        const set = byFile.get(join(SPEC_DIR, target)) ?? new Set<string>();
        if (!set.has(number)) {
          findings.push({
            file: rel,
            line: at,
            rule: 'R2',
            text: `the reference to \`${m[2]}\` section ${number} points at a section that does not exist`,
          });
        }
      }
    });
  }

  if (findings.length === 0) {
    console.log('link gate: every reference in the contract layer resolves');
    return;
  }
  findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  for (const f of findings) {
    console.error(`${f.file}:${f.line} [${f.rule}] ${f.text}`);
  }
  console.error(`\nlink gate: ${findings.length} findings`);
  process.exit(1);
}

main();

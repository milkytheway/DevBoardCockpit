import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadVocabulary,
  renderMarkdownTable,
  renderTypeScript,
  parseMarkdownTable,
} from '../../scripts/gen-vocabulary';

/**
 * The golden vector test of the generator of the vocabulary.
 *
 * `docs/spec/data/tag-vocabulary.yaml` is the **only authority** of the core
 * vocabulary (`docs/spec/01-tag-contract.md` §1). Three things have to
 * agree entry by entry:
 *   1. the YAML (the authority)
 *   2. the Markdown table in `docs/spec/01` (the rendered result)
 *   3. the TypeScript that the implementation layer generates
 *      (`src/shared/generated/tag-vocabulary.generated.ts`)
 *
 * The architecture document calls it "the one hard criterion against which
 * the semantics do not drift" and `AGENTS.md` calls it "the cross-check is a
 * hard criterion". **A criterion has to be able to run by itself**, otherwise
 * it is only a slogan.
 */

const VOCAB_PATH = join(process.cwd(), 'docs/spec/data/tag-vocabulary.yaml');
const DOC_PATH = join(process.cwd(), 'docs/spec/01-tag-contract.md');

describe('the generator of the vocabulary', () => {
  const vocab = loadVocabulary(VOCAB_PATH);

  it('every entry is read out of the YAML', () => {
    expect(vocab.length).toBeGreaterThan(0);
    expect(vocab[0].pattern).toBe('cpu.usage');
  });

  it('the generated Markdown table agrees with the table of the document entry by entry', () => {
    const doc = readFileSync(DOC_PATH, 'utf8');
    const fromDoc = parseMarkdownTable(doc);
    const fromYaml = vocab.map((e) => ({
      pattern: e.pattern,
      type: e.type,
      unit: e.unit,
      range: Array.isArray(e.range) ? `[${e.range.join(',')}]` : String(e.range),
      semantics: e.semantics,
      v1: e.v1,
    }));

    expect(fromDoc).toEqual(fromYaml);
  });

  it('the generated TypeScript covers every entry and has all the fields', () => {
    const ts = renderTypeScript(vocab);
    for (const e of vocab) {
      expect(ts).toContain(`'${e.pattern}'`);
    }
    expect(ts).toContain('export const CORE_VOCABULARY');
    expect(ts).toContain('export type CoreTagName');
  });

  it('the type is limited to the five the contract allows', () => {
    const allowed = new Set(['number', 'string', 'boolean', 'enum']);
    for (const e of vocab) {
      expect(allowed.has(e.type)).toBe(true);
    }
  });

  it('there are only two states of v1', () => {
    const allowed = new Set(['required', 'reserved']);
    for (const e of vocab) {
      expect(allowed.has(e.v1)).toBe(true);
    }
  });

  it('the rendered table head agrees with the document', () => {
    const doc = readFileSync(DOC_PATH, 'utf8');
    const header = '| Pattern | Type | Unit | Range | Semantics | v1 |';
    expect(doc).toContain(header);
    expect(renderMarkdownTable(vocab)).toContain(header);
  });
});

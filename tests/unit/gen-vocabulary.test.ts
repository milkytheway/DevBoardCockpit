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
 * 词表生成器的黄金向量测试。
 *
 * `docs/spec/data/tag-vocabulary.yaml` 是核心词表的**唯一权威**
 * （`docs/spec/01-tag-contract.md` §一）。三份东西必须逐条一致：
 *   1. YAML（权威）
 *   2. `docs/spec/01` 里的 Markdown 表格（渲染结果）
 *   3. 实现层生成的 TS（`src/shared/generated/tag-vocabulary.generated.ts`）
 *
 * `docs/04-架构设计.md` §4.3 把它叫「语义不漂移的唯一硬判据」，
 * `AGENTS.md` 把它叫「对拍是硬判据」。**判据必须能自动跑**，
 * 否则它只是一句口号。
 */

const VOCAB_PATH = join(process.cwd(), 'docs/spec/data/tag-vocabulary.yaml');
const DOC_PATH = join(process.cwd(), 'docs/spec/01-tag-contract.md');

describe('词表生成器', () => {
  const vocab = loadVocabulary(VOCAB_PATH);

  it('从 YAML 读出全部条目', () => {
    expect(vocab.length).toBeGreaterThan(0);
    expect(vocab[0].pattern).toBe('cpu.usage');
  });

  it('生成的 Markdown 表格与文档里那张表逐条一致', () => {
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

  it('生成的 TypeScript 覆盖全部条目，字段齐全', () => {
    const ts = renderTypeScript(vocab);
    for (const e of vocab) {
      expect(ts).toContain(`'${e.pattern}'`);
    }
    expect(ts).toContain('export const CORE_VOCABULARY');
    expect(ts).toContain('export type CoreTagName');
  });

  it('类型受限于契约允许的五种', () => {
    const allowed = new Set(['number', 'string', 'boolean', 'enum']);
    for (const e of vocab) {
      expect(allowed.has(e.type)).toBe(true);
    }
  });

  it('v1 状态只有两种', () => {
    const allowed = new Set(['required', 'reserved']);
    for (const e of vocab) {
      expect(allowed.has(e.v1)).toBe(true);
    }
  });

  it('渲染的表格头与文档一致', () => {
    const doc = readFileSync(DOC_PATH, 'utf8');
    const header = '| 模式 | 类型 | 单位 | 取值域 | 语义 | v1 |';
    expect(doc).toContain(header);
    expect(renderMarkdownTable(vocab)).toContain(header);
  });
});

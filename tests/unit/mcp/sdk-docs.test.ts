import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';
import { sdkDocs, SDK_TOPICS, setSdkCardsDir } from '../../../src/main/mcp/sdk-docs';

/**
 * The live SDK documentation (contract `spec/04` §2.3, `get_card_sdk_docs`).
 *
 * Why it has to be **generated from the live code**:
 *
 * **Hand-copied static text drifts** — when the API gains a method the text
 * does not update itself, so an agent writes against an **API that does not
 * exist** and the card reports "no such method" on the first call, and
 * **nobody can tell which side is wrong**. That is the same drift as in the
 * API registry itself.
 *
 * The **shape** comes from the code (the registry, the whitelist of the closed
 * schema) and the **meaning** comes from the contract (what a field means —
 * the code does not hold that).
 */
/** **the real card directory** — the `examples` topic lists **real cards** (invented ones would not match reality) */
const CARDS_DIR = join(__dirname, '../../../cards');

describe('MCP · the live SDK documentation', () => {
  beforeAll(() => {
    setSdkCardsDir(CARDS_DIR);
  });

  it('**all four topics are there** (the four listed in contract §2.3)', () => {
    expect(SDK_TOPICS).toEqual(['manifest', 'api', 'examples', 'layout']);
  });

  it('**the topic is omitted → everything is returned** (contract §2.3)', () => {
    const docs = sdkDocs(undefined);
    expect(docs.topics).toEqual(['manifest', 'api', 'examples', 'layout']);
    // **content is a string** (the agent reads it as part of a prompt)
    expect(typeof docs.content).toBe('string');
    expect(docs.content.length).toBeGreaterThan(0);
  });

  it('**one topic is named → only that one is returned**', () => {
    const docs = sdkDocs('api');
    expect(docs.topics).toEqual(['api']);
    expect(docs.content).toContain('tags.get');
    // **no other topic is included**
    expect(docs.content).not.toContain('min_board_pack');
  });

  it('**the `api` topic lists the methods this build actually has** (**a method that is not implemented is not listed**)', () => {
    const docs = sdkDocs('api');
    expect(docs.content).toContain('tags.get');
    expect(docs.content).toContain('actions.invoke');
    expect(docs.content).toContain('workflows.run');
    expect(docs.content).toContain('storage.set');
    // **`notify` is not implemented** → **it is not listed** (listing it would mean
// the card believes the notification went out)
    expect(docs.content).not.toContain('cockpit.notify');
  });

  it('**every method carries a sentence of explanation** (**the name alone is not enough** — the agent does not know when to use it)', () => {
    const docs = sdkDocs('api');
    // **the explanation of `tags.get`**
    expect(docs.content).toMatch(/tags\.get[\s\S]{0,200}?Read/);
  });

  it('**the `manifest` topic gives the field table of the closed schema** (**taken from the code**)', () => {
    const docs = sdkDocs('manifest');
    expect(docs.content).toContain('permissions');
    expect(docs.content).toContain('entry');
    expect(docs.content).toContain('apiVersion');
    // **an unknown field is an error** → the documentation has to say so
    expect(docs.content).toContain('Unknown fields');
  });

  it('**the `layout` topic uses the words of the contract** (`cards` / `card_id`, not the `units` / `cardId` of the implementation)', () => {
    const docs = sdkDocs('layout');
    expect(docs.content).toContain('card_id');
    expect(docs.content).toContain('cards');
  });

  it('**the `examples` topic lists the built-in cards** (**real cards**, not invented ones)', () => {
    const docs = sdkDocs('examples');
    expect(docs.content).toContain('cpu-usage');
    // **it shows the read permissions** (an agent editing the manifest has to know
// what it may read)
    expect(docs.content).toContain('permissions.read');
    // **the read permissions are real** (**not invented** — a real card reads
// `cpu.usage`)
    expect(docs.content).toContain('cpu.usage');
  });

  it('**an unknown topic → empty content** (**it does not guess**)', () => {
    const docs = sdkDocs('nope' as never);
    expect(docs.topics).toEqual([]);
    expect(docs.content).toBe('');
  });

  it('**every response carries apiVersion** (contract §4)', () => {
    expect(sdkDocs('api')['apiVersion']).toBe('devboard/v1');
  });
});

import { CORE_VOCABULARY } from '../../shared/generated/tag-vocabulary.generated';

/**
 * The capability vocabulary and the matching of the tag patterns.
 *
 * Contract: `docs/spec/02-board-pack.md` section 10.3 (the capability
 * vocabulary and the table of word meanings), section 1.1 (the two
 * namespaces of sample and tag), section 7 rules 1 / 25 / 26.
 * Decision: the board-level and the connection-level vocabularies are two
 * separate axes.
 *
 * ── Two vocabularies, two axes ──
 *
 * | | Board-level capability | Connection-level capability |
 * |---|---|---|
 * | Answers | what this board can do | what this connection can do |
 * | Closed vocabulary | `{shell, exec, stream, files}` | `{exec, pty, files, exitCode}` |
 * | Declared by | the board pack (`requires.capabilities`) | the runtime, negotiated per profile |
 *
 * Same name, different meaning: a serial line cannot transfer files (fact
 * S7) but the board of course has a file channel — so `files` is a
 * property of the board in the contract and a property of the connection in
 * the implementation. That is why the type in the implementation is called
 * `ConnectionCapabilities` and not `Capabilities`.
 */

/** The board-level capability vocabulary (closed, contract section 10.3.1) */
export const BOARD_CAPABILITIES = ['shell', 'exec', 'stream', 'files'] as const;

/**
 * The board-level capabilities the runtime implements (the data of rule
 * 26).
 *
 * `stream` is not among them: the business contract of the stream has not
 * been written yet (`spec/00` section 7), so declaring it would not deliver
 * anything — rule 26 rejects it as an error.
 *
 * This table is data, not a rule. The day the stream lands, what changes is
 * this table, not rule 26.
 */
export const IMPLEMENTED_CAPABILITIES = ['shell', 'exec', 'files'] as const;

/** Whether this word is one of the board-level capability vocabulary (rule 25) */
export function isBoardCapability(value: string): boolean {
  return (BOARD_CAPABILITIES as readonly string[]).includes(value);
}

/** Whether this capability can be delivered right now (rule 26) */
export function isImplementedCapability(value: string): boolean {
  return (IMPLEMENTED_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * The pattern matching of a tag.
 *
 * `*` eats exactly one segment and does not eat an empty segment.
 *
 * It is used on two namespaces at the same time — the pattern rules of tag
 * and sample are the same, only the namespace of the name differs (contract
 * section 1.1). Rule 7 ("the number of `*` of the tag and of the sample must
 * be equal") holds on that basis.
 */
export function matchTagPattern(pattern: string, name: string): boolean {
  const ps = pattern.split('.');
  const ns = name.split('.');
  // The number of segments has to be equal (rule 7: "the segments do not
  // have to be equal" is about the tag and the sample, not about the pattern
  // and the name — within one match the number of segments has to be the
  // same)
  if (ps.length !== ns.length) return false;
  for (let i = 0; i < ps.length; i += 1) {
    if (ps[i] === '*') {
      // A wildcard segment cannot match an empty segment: `cpu.core..usage` is not `cpu.core.*.usage`
      if (ns[i].length === 0) return false;
      continue;
    }
    if (ps[i] !== ns[i]) return false;
  }
  return true;
}

/** The core vocabulary (the machine-readable form generated from the YAML) — rule 1 and the unit look it up */
export { CORE_VOCABULARY };

/**
 * Whether this tag is in the core vocabulary (rule 1).
 *
 * The entries of the core vocabulary are patterns (`cpu.core.*.usage`),
 * so it has to be compared as a pattern and not as a string.
 */
export function isCoreTag(name: string): boolean {
  return CORE_VOCABULARY.some((entry) => matchTagPattern(entry.pattern, name));
}

/**
 * Whether this tag is a private quantity of the custom namespace of this
 * pack (rule 1).
 *
 * The namespace is `custom.<pack id>.` — the pack id has to be its own, and
 * the private quantities of another pack may not be borrowed (that would
 * mix the semantics of two board types).
 */
export function isCustomTag(name: string, packId: string): boolean {
  return name.startsWith(`custom.${packId}.`);
}

/**
 * Bind one concrete sample to a tag (contract section 1.1).
 *
 * "the positions of the `*` correspond one to one" means that the i-th
 * wildcard segment of the tag corresponds to the i-th wildcard segment of
 * the sample, not the same segment number:
 *
 * ```
 * tag:    cpu.core.*.usage   ← the 0th wildcard segment is the 2nd segment
 * sample: core.*.usage       ← the 0th wildcard segment is the 1st segment
 * ```
 *
 * The sample `core.3.usage` → the tag `cpu.core.3.usage`.
 *
 * @returns null when it cannot be bound (do not guess).
 */
export function bindSampleToTag(
  tagPattern: string,
  samplePattern: string,
  concreteSample: string,
): string | null {
  const tagParts = tagPattern.split('.');
  const sampleParts = samplePattern.split('.');
  const concrete = concreteSample.split('.');

  if (concrete.length !== sampleParts.length) return null;

    // The literal segments have to match one by one
  for (let i = 0; i < sampleParts.length; i += 1) {
    if (sampleParts[i] !== '*' && sampleParts[i] !== concrete[i]) return null;
  }

  // Collect the wildcard values of the sample (in the order of appearance)
  const values: string[] = [];
  for (let i = 0; i < sampleParts.length; i += 1) {
    if (sampleParts[i] === '*') values.push(concrete[i]!);
  }

  // Fill the wildcard positions of the tag (in the order of appearance)
  const out = tagParts.slice();
  let k = 0;
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] !== '*') continue;
    const value = values[k];
    if (value === undefined) return null; // the number of wildcards differs (rule 7)
    out[i] = value;
    k += 1;
  }
  if (k !== values.length) return null;

  return out.join('.');
}

/**
 * The unit of a tag (looked up in the core vocabulary).
 *
 * A tag in the custom namespace is not in the core vocabulary → the unit is
 * `-` (dimensionless).
 */

export function unitForTag(tag: string): string {
  const entry = CORE_VOCABULARY.find((e) => matchTagPattern(e.pattern, tag));
  return entry?.unit ?? '-';
}

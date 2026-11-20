import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseManifest, type CardManifest } from './manifest';
import { validateCard, type CardIssue } from './validate';
import type { McpValidateResult } from '../mcp/host';
import type { PackView } from '../tags/pack-view';
import type { TagReading } from '../../shared/tag-reading';
import { matchTagPattern } from '../tags/vocabulary';

/**
 * **Validates a card directory** (contract `spec/04` §2.3 ✓ · ADR-D40 ✓).
 *
 * ── A static validation, **no installation** ✓ ──
 *
 * → The rules are the **14 rules of contract §9** ✓ (`cards/validate.ts` ✓ —
 * not rewritten ✓).
 *
 * ── The three readings of `resolved` ──
 *
 * | Field | Reading |
 * |---|---|
 * | `tags` | **declared ∩ currently readable** ✓ (**the concrete names** ✓) |
 * | `actions` | **declared ∩ present in the current pack** ✓ |
 * | `missing_tags` | declared but **not readable right now** ✓ |
 * | `missing_actions` | declared but **not in the current pack** ✓ |
 *
 * → It is **not** `permissions.read` copied verbatim ✓ — otherwise the agent
 * would not know "what can really be bound" ✓.
 */

/** Computes what `validate_card` needs */
export interface ValidateCardInput {
  /** The absolute path of the card directory ✓ */
  dir: string;
  /** The redacted view of the current board pack (**`null` when there is none** ✓ — then there is no such thing as "in the pack" ✓) */
  pack: PackView | null;
  /** The current readings (**used to decide what is "readable"** ✓) */
  readings: TagReading[];
  /** The action ids declared in the board pack (**empty when there is no pack** ✓) */
  actionIds: string[];
  /** The ids of the cards that are already installed (**rule 2** ✓ — **it has to exclude itself** ✓) */
  installedCardIds: string[];
}

/**
 * **Validates a card directory** ✓.
 *
 * → **The manifest cannot be read → reported as an error** ✓ (**not thrown**
 * ✓ — contract §4 "does not throw" ✓).
 * → **The rules are the ones of contract §9** ✓ (`validateCard` ✓).
 */
export function validateCardAt(input: ValidateCardInput): McpValidateResult {
  const manifestPath = join(input.dir, 'manifest.json');

  // **There is no manifest in the directory** → an error of the `not_found` kind ✓
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      errors: [
        {
          severity: 'error',
          rule: 10,
          path: 'manifest.json',
          message: 'there is no manifest.json in this directory',
        },
      ],
      warnings: [],
      resolved: { tags: [], actions: [], layout: null, missing_tags: [], missing_actions: [] },
    };
  }

  let manifest: CardManifest;
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    manifest = parseManifest(raw, input.dir);
  } catch (err) {
    // **The manifest cannot be read / is invalid** → reported as an error ✓ (rule 10 ✓ — that is the "structural" family ✓)
    return {
      ok: false,
      errors: [
        {
          severity: 'error',
          rule: 10,
          path: 'manifest.json',
          message: err instanceof Error ? err.message : String(err),
        },
      ],
      warnings: [],
      resolved: { tags: [], actions: [], layout: null, missing_tags: [], missing_actions: [] },
    };
  }

  const result = validateCard(manifest, {
    // **The tags that are readable on the current board** (**the concrete names** ✓) — the "is the action in the pack" of rule 5 is another thing ✓
    availableTags: input.readings.filter((r) => r.status === 'ok').map((r) => r.tag),
    availableActions: input.pack === null ? null : input.actionIds,
    // **The host knows the workflow ids itself** ✓ — they are not passed here (**`null` = offline** ✓ → degraded into a warning ✓)
    availableWorkflows: null,
    // **Rule 2 compares the id of the manifest** ✓, **and it has to exclude itself** ✓
    installedCardIds: input.installedCardIds,
    fileExists: (rel) => existsSync(join(input.dir, rel)),
  });

  // ── The three readings of `resolved` ──
  // **"Readable"**: the declared pattern covers a currently **readable concrete name** ✓
  const tags: string[] = [];
  for (const reading of input.readings) {
    if (reading.status !== 'ok') continue;
    if (!manifest.permissions.read.some((p) => matchTagPattern(p, reading.tag))) continue;
    if (!tags.includes(reading.tag)) tags.push(reading.tag);
  }
  // **"Not readable right now"**: judged **per pattern** ✓ — that is, the pattern **bound no concrete name at all** ✓
  // → **The pattern itself is recorded** ✓ (the host has **no "pattern → concrete name" expander** ✓ — no guessing ✓)
  const missingTags: string[] = [];
  for (const pattern of manifest.permissions.read) {
    const bound = input.readings.some((r) => matchTagPattern(pattern, r.tag));
    if (!bound) missingTags.push(pattern);
  }

  const actions: string[] = [];
  const missingActions: string[] = [];
  const availableActions = new Set(input.actionIds);
  for (const id of manifest.permissions.write) {
    if (availableActions.has(id)) actions.push(id);
    else missingActions.push(id);
  }

  return {
    ok: result.ok,
    errors: result.errors.map(issueView),
    warnings: result.warnings.map(issueView),
    resolved: {
      tags,
      actions,
      layout: result.resolved.layout,
      missing_tags: missingTags,
      missing_actions: missingActions,
    },
  };
}

/** A validation problem → the copy the tool returns (**the field names are the same** ✓) */
function issueView(issue: CardIssue): {
  severity: string;
  rule: number;
  path: string;
  message: string;
} {
  return {
    severity: issue.severity,
    rule: issue.rule,
    path: issue.path,
    message: issue.message,
  };
}

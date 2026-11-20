import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cardApis } from '../cards/api-registry';
import {
  ACTION_ALLOWED,
  ACTION_REQUIRED,
  LAYOUT_ALLOWED,
  PARAM_ALLOWED,
  PARAM_TYPES,
  PERMISSIONS_ALLOWED,
  PERMISSIONS_REQUIRED,
  REQUIRES_ALLOWED,
  TOP_ALLOWED,
  TOP_REQUIRED,
} from '../cards/manifest';
import { API_VERSION } from './convention';

/**
 * The **live SDK documentation** (the `get_card_sdk_docs` of contract
 * `spec/04` §2.3 ✓ · ADR-D40 ✓).
 *
 * ── Why it has to be "generated from the live code" ──
 *
 * **A hand-copied static text drifts** ✓ — when the API gains a method it does
 * not update itself ✓
 * → an agent that follows it calls an **API that does not exist** ✗ → as soon
 * as the card calls it it reports "the method does not exist" ✗
 * → **and nobody can tell which side is wrong** ✗ (that is the same drift as
 * the API registry itself ✓).
 *
 * → **The shape comes from the code** ✓ (the registry ✓ · the closed schema
 * allow list ✓)
 * → **The semantics come from the contract** ✓ (what a field means ✓ — that
 *   is not in the code ✓).
 *
 * ── "What this build actually has" and "the full set of the contract" are two
 * different things ──
 *
 * `capabilities().methods` lists **what is actually there** ✓ — so **what is
 * not implemented is not listed** ✓
 * (`notify` has still not been wired up ✓ — listing it = the card believes the
 * notification went out ✓ while nobody handles it ✓).
 */

/** The four topics (**the contract §2.3 lists exactly these four** ✓) */
/** **The built-in card directory** (the host sets it when it wires things up ✓ — after the packaging it is the `cards/` of the app ✓) */
let cardsDir: string | undefined;

/** Tells it where the built-in cards are ✓ (**without it there are no examples** ✓ — no guessing ✓) */
export function setSdkCardsDir(dir: string | undefined): void {
  cardsDir = dir;
}

export const SDK_TOPICS = ['manifest', 'api', 'examples', 'layout'] as const;

/** One topic */
export type SdkTopic = (typeof SDK_TOPICS)[number];

/** The return of the SDK documentation (contract §2.3 ✓) */
export interface SdkDocs {
  apiVersion: string;
  topics: string[];
  /** **One string** ✓ (the agent reads it as part of a prompt ✓) */
  content: string;
}

/**
 * **The list of the built-in cards** (used by the `examples` topic ✓).
 *
 * → **Read from the real directory** ✓ — and not made up ✓ (a made-up list
 *   would not match reality ✓).
 * → **Empty when it cannot be read** ✓ (no guessing ✓ — after the packaging
 *   there may be no source directory ✓).
 *
 * → **Injected instead of importing fs directly** ✓: this module is called
 *   directly by the unit tests ✓ — the test feeds a fake list ✓, the runtime
 *   feeds the real one ✓.
 */
function builtinCardSummaries(cardsDir: string | undefined): string[] {
  if (cardsDir === undefined || cardsDir.length === 0) return [];
  let names: string[];
  try {
    names = readdirSync(cardsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const manifestPath = join(cardsDir, name, 'manifest.json');
    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
      if (raw === null || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const id = typeof r['id'] === 'string' ? r['id'] : name;
      const label = typeof r['name'] === 'string' ? r['name'] : id;
      // **`permissions` is an object** ✓ (not an array ✓ — that is the shape of `requires` ✓)
      const perms = (r['permissions'] ?? {}) as { read?: unknown };
      const tags = Array.isArray(perms.read)
        ? perms.read.filter((t): t is string => typeof t === 'string')
        : [];
      out.push(
        `## ${id} (${label})\n` +
          `- Directory name: \`${name}\`\n` +
          `- \`permissions.read\`: ${tags.length > 0 ? tags.map((t) => `\`${t}\``).join(' / ') : '(none)'}\n` +
          '- Use it as a template: copy the directory → edit the manifest → edit the entry file.',
      );
    } catch {
      // **Skipped when it cannot be read** ✓ (no guessing ✓) — a broken card must not make the whole document fail ✓
    }
  }
  return out;
}

/**
 * **Generates the SDK documentation** ✓.
 *
 * @param topic which part is wanted (**left out = all of it** ✓ — contract §2.3 ✓)
 */
export function sdkDocs(
  topic?: string,
  examples: string[] = builtinCardSummaries(cardsDir),
): SdkDocs {
  const wanted =
    topic === undefined
      ? [...SDK_TOPICS]
      : SDK_TOPICS.includes(topic as SdkTopic)
        ? [topic as SdkTopic]
        : [];

  const parts: string[] = [];
  for (const t of wanted) {
    parts.push(sectionOf(t, examples));
  }
  return {
    apiVersion: API_VERSION,
    topics: wanted,
    content: parts.join('\n\n'),
  };
}

/** The content of one topic ✓ */
function sectionOf(topic: SdkTopic, examples: string[]): string {
  switch (topic) {
    case 'manifest':
      return manifestSection();
    case 'api':
      return apiSection();
    case 'examples':
      return examplesSection(examples);
    case 'layout':
      return layoutSection();
  }
}

/** The `manifest` topic — **the shape comes from the code** ✓, the semantics are written by hand ✓ (that is not in the code ✓) */
function manifestSection(): string {
  return [
    '# Card manifest format',
    '',
    'manifest.json sits at the root of the card directory. **Every level of it is closed** —',
    '**Unknown fields raise an error** (they are not silently ignored): a silently ignored field is a **misspelled field**',
    '(for example, writing `permisons` leaves the card with **no read permission**, and the author can never find out why).',
    '',
    `Top-level fields (writable): ${TOP_ALLOWED.join(' / ')}`,
    `Top-level required: ${TOP_REQUIRED.join(' / ')}`,
    '',
    '## What the fields mean',
    '',
    '- `apiVersion`: the contract version; v1 writes `devboard/v1`.',
    '- `kind`: always `Card`.',
    '- `id`: the card id. **It must equal the card directory name**.',
    '- `name` / `version` / `description`: for humans.',
    '- `entry`: the entry file (relative to the card directory).',
    '- `requires`: the **wishes** (what you want to read, what you want to write) — it must be covered by `permissions`.',
    '- `permissions`: the **permission request** (what you may read, what you may write).',
    '- `actions`: the view-local actions the card declares for itself (the ones that **do not touch the board**).',
    '- `layout`: the default cell size (12-column grid).',
    '',
    `## fields of requires (writable): ${REQUIRES_ALLOWED.join(' / ')}`,
    `## fields of permissions (writable): ${PERMISSIONS_ALLOWED.join(' / ')}`,
    `### permissions required: ${PERMISSIONS_REQUIRED.join(' / ')}`,
    '',
    'Every tag name in `permissions.read` must either match the **core vocabulary** or fall under `custom.*`.',
    'Every id in `permissions.write` must be an **action id declared by the board pack**, and **wildcards are not allowed**.',
    '',
    `## fields of actions[] (writable): ${ACTION_ALLOWED.join(' / ')}`,
    `### actions[] required: ${ACTION_REQUIRED.join(' / ')}`,
    `## fields of actions[].params.<name> (writable): ${PARAM_ALLOWED.join(' / ')}`,
    `### values of params.<name>.type: ${PARAM_TYPES.join(' / ')}`,
    '',
    '**A `string` parameter must declare `maxLength`** — a string parameter without an upper bound is an injection surface.',
  ].join('\n');
}

/** The `api` topic — **generated from the registry** ✓ */
function apiSection(): string {
  const lines = [
    '# APIs available to cards',
    '',
    'These are the methods **this build actually has** (not the full contract set).',
    'Inside a card, call them as `cockpit.<name>(...)`; they return `{ ok: true, ... }` or `{ ok: false, reason }`.',
    '',
  ];
  for (const api of cardApis()) {
    const params = api.params.length > 0 ? api.params.join(', ') : '(none)';
    lines.push(`## cockpit.${api.name}`);
    lines.push(api.summary);
    lines.push(`- Parameters: ${params}`);
    lines.push(`- Permission dimension: ${api.permission}`);
    if (api.subscribable === true) lines.push('- **Subscribable** (a long-lived connection; subscribing goes through a permission check)');
    lines.push('');
  }
  return lines.join('\n');
}

/** The `examples` topic — **real cards** ✓ */
function examplesSection(examples: string[]): string {
  const lines = [
    '# Example cards',
    '',
    'One card = one directory: `manifest.json` + the entry file that `entry` points to (HTML/JS/CSS).',
    'The APIs inside a card are injected by the host (`window.cockpit`) — **do not fetch by yourself** (the CSP blocks the network).',
    '',
  ];
  if (examples.length === 0) {
    lines.push('(This build has no built-in example cards.)');
    return lines.join('\n');
  }
  for (const example of examples) {
    lines.push(example);
    lines.push('');
  }
  return lines.join('\n');
}

/** The `layout` topic — **the words of the contract** ✓ (`cards` / `card_id` ✓ — not the internal words of the implementation ✓) */
function layoutSection(): string {
  return [
    '# Main area layout',
    '',
    'The main area is a **grid of cards** (12 columns). Each cell records where a card sits.',
    '',
    '## Shape',
    '',
    '```',
    '{ cards: [{ card_id, connection_id, x, y, w, h }] }',
    '```',
    '',
    '- `card_id`: the card id (the same name and meaning as the `id` of `list_cards`).',
    '- `connection_id`: which connection this cell is bound to (`null` = no connection context).',
    '- `x` / `y`: the cell coordinates (top-left corner).',
    '- `w` / `h`: the cell size (columns / rows), `w` is in `1..12`.',
    '',
    '## Two points to note',
    '',
    '- **The layout key is `(card_id, connection_id)`** — the same card has one cell per connection.',
    '- **`w` / `h` are the **wishes** of the card ✓ — the actual size is decided by the layout ✓.',
    '',
    `The default size of the card lives in the \`layout\` of the manifest (writable fields: ${LAYOUT_ALLOWED.join(' / ')}).`,
  ].join('\n');
}

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
 * **SDK 活文档**（契约 `spec/04` §2.3 的 `get_card_sdk_docs` ✓ · ADR-D40 ✓）。
 *
 * ── 为什么必须是「从活代码生成」──
 *
 * **手抄的静态文本会漂** ✓ —— API 加一个方法它不会自己更新 ✓
 * → agent 照着写会调一个**不存在的 API** ✗ → 卡片一调就报「方法不存在」✗
 * → **而没人查得出是哪边错了** ✗（那跟 API 注册表自己漂了一样 ✗）。
 *
 * → **形状取自代码** ✓（注册表 ✓ · 封闭 schema 白名单 ✓）
 * → **语义取自契约** ✓（字段是什么意思 ✓ —— 代码里没有那个 ✓）。
 *
 * ── 「本 build 实际有的」与「契约全集」是两回事 ──
 *
 * `capabilities().methods` 列的是**实际有的** ✓ —— 所以**没实现的就不列** ✓
 * （`notify` 至今没接上 ✓ —— 列了 = 卡片以为通知发出去了 ✓，其实没人管 ✓）。
 */

/** 四个主题（**契约 §2.3 列的就是这四个** ✓） */
/** **内置卡片目录**（宿主接线时设它 ✓ —— 打包后是 app 里的 `cards/` ✓） */
let cardsDir: string | undefined;

/** 告诉它内置卡在哪儿 ✓（**没设就没有 examples** ✓ —— 不猜 ✓） */
export function setSdkCardsDir(dir: string | undefined): void {
  cardsDir = dir;
}

export const SDK_TOPICS = ['manifest', 'api', 'examples', 'layout'] as const;

/** 一个主题 */
export type SdkTopic = (typeof SDK_TOPICS)[number];

/** SDK 文档的返回（契约 §2.3 ✓） */
export interface SdkDocs {
  apiVersion: string;
  topics: string[];
  /** **一个字符串** ✓（agent 把它当提示词的一部分读 ✓） */
  content: string;
}

/**
 * **内置卡片的清单**（`examples` 主题用 ✓）。
 *
 * → **从真目录读** ✓ —— 不是编的 ✓（编的会与实际不符 ✓）。
 * → **读不到就空** ✓（不猜 ✓ —— 打包后可能没有源目录 ✓）。
 *
 * → **用注入而不是直接 import fs** ✓：这个模块会被单测直接调 ✓ ——
 *   测试里塞假的清单 ✓，运行时塞真的 ✓。
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
      // **`permissions` 是一个对象** ✓（不是数组 ✓ —— 那是 `requires` 的形状 ✓）
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
      // **读不出来就跳过** ✓（不猜 ✓）—— 坏卡不该让整份文档失败 ✓
    }
  }
  return out;
}

/**
 * **生成 SDK 文档** ✓。
 *
 * @param topic 要哪一块（**省略 = 全部** ✓ —— 契约 §2.3 ✓）
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

/** 一个主题的内容 ✓ */
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

/** `manifest` 主题 —— **形状从代码取** ✓，语义是手写的 ✓（代码里没有那个 ✓） */
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

/** `api` 主题 —— **从注册表生成** ✓ */
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

/** `examples` 主题 —— **真卡** ✓ */
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

/** `layout` 主题 —— **用契约的词** ✓（`cards` / `card_id` ✓ —— 不是实现的内部词 ✓） */
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

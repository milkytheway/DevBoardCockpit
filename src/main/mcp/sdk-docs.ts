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
        `## ${id}（${label}）\n` +
          `- 目录名：\`${name}\`\n` +
          `- \`permissions.read\`：${tags.length > 0 ? tags.map((t) => `\`${t}\``).join(' / ') : '（无）'}\n` +
          '- 用它当模板：复制目录 → 改 manifest → 改入口文件。',
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
    '# 卡片 manifest 格式',
    '',
    'manifest.json 在卡片目录的根下。它的**每一层都是封闭的** ——',
    '**未知字段会报错**（不是静默忽略）：被静默忽略的字段就是**拼错的字段**',
    '（比如写成 `permisons`，卡片会**没有读权限**，而作者永远查不出原因）。',
    '',
    `顶层字段（可写）：${TOP_ALLOWED.join(' / ')}`,
    `顶层必填：${TOP_REQUIRED.join(' / ')}`,
    '',
    '## 字段的意思',
    '',
    '- `apiVersion`：契约版本，v1 写 `devboard/v1`。',
    '- `kind`：固定写 `Card`。',
    '- `id`：卡片 id。**必须等于卡片目录名**。',
    '- `name` / `version` / `description`：给人看的。',
    '- `entry`：入口文件（相对卡片目录）。',
    '- `requires`：**愿望**（想读什么、想写什么）——必须被 `permissions` 覆盖。',
    '- `permissions`：**授权申请**（能读什么、能写什么）。',
    '- `actions`：卡片自报的视图内动作（**不碰板子**的那些）。',
    '- `layout`：默认格子尺寸（12 列网格）。',
    '',
    `## requires 的字段（可写）：${REQUIRES_ALLOWED.join(' / ')}`,
    `## permissions 的字段（可写）：${PERMISSIONS_ALLOWED.join(' / ')}`,
    `### permissions 必填：${PERMISSIONS_REQUIRED.join(' / ')}`,
    '',
    '`permissions.read` 里每个 tag 名要么匹配**核心词表**，要么落在 `custom.*` 下。',
    '`permissions.write` 里每个 id 必须是**板型包里声明的动作 id**，且**不许通配符**。',
    '',
    `## actions[] 的字段（可写）：${ACTION_ALLOWED.join(' / ')}`,
    `### actions[] 必填：${ACTION_REQUIRED.join(' / ')}`,
    `## actions[].params.<name> 的字段（可写）：${PARAM_ALLOWED.join(' / ')}`,
    `### params.<name>.type 的取值：${PARAM_TYPES.join(' / ')}`,
    '',
    '**`string` 参数必须声明 `maxLength`** —— 没有上限的字符串参数就是注入面。',
  ].join('\n');
}

/** `api` 主题 —— **从注册表生成** ✓ */
function apiSection(): string {
  const lines = [
    '# 卡片可用的 API',
    '',
    '这些是**本 build 实际有的**方法（不是契约全集）。',
    '卡片里的用法是 `cockpit.<name>(...)`，返回 `{ ok: true, ... }` 或 `{ ok: false, reason }`。',
    '',
  ];
  for (const api of cardApis()) {
    const params = api.params.length > 0 ? api.params.join(', ') : '（无）';
    lines.push(`## cockpit.${api.name}`);
    lines.push(api.summary);
    lines.push(`- 参数：${params}`);
    lines.push(`- 权限维度：${api.permission}`);
    if (api.subscribable === true) lines.push('- **可订阅**（长连接，订阅要走权限检查）');
    lines.push('');
  }
  return lines.join('\n');
}

/** `examples` 主题 —— **真卡** ✓ */
function examplesSection(examples: string[]): string {
  const lines = [
    '# 示例卡片',
    '',
    '一张卡 = 一个目录：`manifest.json` + `entry` 指向的入口文件（HTML/JS/CSS）。',
    '卡片里的 API 由宿主注入（`window.cockpit`）——**不要自己 fetch**（CSP 断了网络）。',
    '',
  ];
  if (examples.length === 0) {
    lines.push('（本 build 没有内置示例卡片。）');
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
    '# 主区布局',
    '',
    '主区是一张**卡片网格**（12 列）。每格记一张卡在哪。',
    '',
    '## 形状',
    '',
    '```',
    '{ cards: [{ card_id, connection_id, x, y, w, h }] }',
    '```',
    '',
    '- `card_id`：卡片 id（与 `list_cards` 的 `id` 同名同义）。',
    '- `connection_id`：这一格绑的是哪条连接（`null` = 没有连接上下文）。',
    '- `x` / `y`：格子坐标（左上角）。',
    '- `w` / `h`：格子尺寸（列 / 行），`w` 在 `1..12`。',
    '',
    '## 两个要点',
    '',
    '- **布局的键是 `(card_id, connection_id)`** —— 同一张卡在两条连接上各有一个格子。',
    '- **`w` / `h` 是卡片的**心愿** ✓ —— 实际摆多大由布局决定 ✓。',
    '',
    `卡片的默认尺寸在 manifest 的 \`layout\` 里（可写字段：${LAYOUT_ALLOWED.join(' / ')}）。`,
  ].join('\n');
}

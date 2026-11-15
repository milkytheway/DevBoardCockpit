import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseManifest, type CardManifest } from './manifest';
import { validateCard, type CardIssue } from './validate';
import type { McpValidateResult } from '../mcp/host';
import type { PackView } from '../tags/pack-view';
import type { TagReading } from '../../shared/tag-reading';
import { matchTagPattern } from '../tags/vocabulary';

/**
 * **校验一个卡片目录**（契约 `spec/04` §2.3 ✓ · ADR-D40 ✓）。
 *
 * ── 静态校验，**不安装** ✓ ──
 *
 * → 规则是**契约 §九 的 14 条** ✓（`cards/validate.ts` ✓ —— 不重写 ✓）。
 *
 * ── `resolved` 的三个口径 ──
 *
 * | 字段 | 口径 |
 * |---|---|
 * | `tags` | **声明 ∩ 当前可读** ✓（**具体名** ✓） |
 * | `actions` | **声明 ∩ 当前包里有** ✓ |
 * | `missing_tags` | 声明了但**当前不可读** ✓ |
 * | `missing_actions` | 声明了但**当前包里没有** ✓ |
 *
 * → **不是**把 `permissions.read` 原样搬出来 ✓ —— 那样 agent 不知道「真能绑上什么」✓。
 */

/** 算 `validate_card` 要的东西 */
export interface ValidateCardInput {
  /** 卡片目录的绝对路径 ✓ */
  dir: string;
  /** 当前板型包的脱敏视图（**没有就是 `null`** ✓ —— 那就没有「包里有」这回事 ✓） */
  pack: PackView | null;
  /** 当前读数（**判「可读」用** ✓） */
  readings: TagReading[];
  /** 板型包里声明的动作 id（**没有包就是空** ✓） */
  actionIds: string[];
  /** 已经装着的卡片 id（**规则 2** ✓ —— **要排除自己** ✓） */
  installedCardIds: string[];
}

/**
 * **校验一个卡片目录** ✓。
 *
 * → **manifest 读不出来 → 报成错误** ✓（**不是抛异常** ✓ —— 契约 §四「不抛异常」✓）。
 * → **规则是契约 §九 的那几条** ✓（`validateCard` ✓）。
 */
export function validateCardAt(input: ValidateCardInput): McpValidateResult {
  const manifestPath = join(input.dir, 'manifest.json');

  // **目录里没有 manifest** → `not_found` 那类错误 ✓
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      errors: [
        {
          severity: 'error',
          rule: 10,
          path: 'manifest.json',
          message: '这个目录里没有 manifest.json',
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
    // **manifest 读不出来 / 不合法** → 报成错误 ✓（规则 10 ✓ —— 那是「结构性的」那一族 ✓）
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
    // **当前板上可读的 tag**（**具体名** ✓）—— 规则 5 的「动作在不在包里」那个是另一个 ✓
    availableTags: input.readings.filter((r) => r.status === 'ok').map((r) => r.tag),
    availableActions: input.pack === null ? null : input.actionIds,
    // **流程 id 宿主自己知道** ✓ —— 这里不传（**null = 离线** ✓ → 降级成警告 ✓）
    availableWorkflows: null,
    // **规则 2 比的是 manifest 的 id** ✓，**且要排除自己** ✓
    installedCardIds: input.installedCardIds,
    fileExists: (rel) => existsSync(join(input.dir, rel)),
  });

  // ── `resolved` 的三个口径 ──
  // **「可读的」**：声明的模式覆盖了当前**可读的具体名** ✓
  const tags: string[] = [];
  for (const reading of input.readings) {
    if (reading.status !== 'ok') continue;
    if (!manifest.permissions.read.some((p) => matchTagPattern(p, reading.tag))) continue;
    if (!tags.includes(reading.tag)) tags.push(reading.tag);
  }
  // **「当前不可读的」**：**逐个模式**判 ✓ —— 那个模式**一个具体名都没绑上** ✓
  // → **记模式本身** ✓（宿主侧**没有「模式 → 具体名」的展开器** ✓ —— 不猜 ✓）
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

/** 校验问题 → 工具返回的那份（**字段名一致** ✓） */
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

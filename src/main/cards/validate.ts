import type { CardManifest } from './manifest';
import { permissionCovers } from './permissions';
import { isCoreTag } from '../tags/vocabulary';

/**
 * 卡片 manifest 的校验（契约 `spec/03` §九 的 **13 条**）。
 *
 * ── 报告里必须带规则号 ──
 *
 * 「这张卡不合法」没用；「**规则 5**：这个动作当前板型包里没有」才有用——
 * 人能照着改，agent 能照着改。
 *
 * ── 「未验证」≠「不合法」 ──
 *
 * 规则 5 在**连不上板**的时候没法查——那时候**不是**这张卡有问题，
 * 是**我们还没查**。所以离线时它进 `warnings`（琥珀），不进 `errors`（红）。
 *
 * ── 规则 10 / 11 / 13 为什么这里看不到 ──
 *
 * 这三条是**结构性的**（未知字段、卡片不许声明 `danger`、参数类型封闭），
 * 已经被**解析器**挡住了（`manifest.ts` 的封闭 schema）——
 * 解析不过的东西**根本到不了这里**。
 * 本文件仍然**复查** 11 与 13（手写的 manifest 对象也能被挡住）；
 * 规则 10 只有解析器能查（解析后字段已经被丢了）。
 */

export interface CardIssue {
  severity: 'error' | 'warning';
  /** 契约 §九 的规则号 */
  rule: number;
  path: string;
  message: string;
}

export interface ValidateCardContext {
  /** 当前板型包提供的 tag。`null` = **离线**（连不上板） */
  availableTags: string[] | null;
  /** 当前板型包声明的动作 id。`null` = **离线** */
  availableActions: string[] | null;
  /** 宿主里已声明的流程 id（规则 14 ✓）。`null` = **离线**（查不到 ✓） */
  availableWorkflows: string[] | null;
  /** 已经装着的卡片 id（规则 2） */
  installedCardIds: string[];
  /** 卡片目录里有没有这个相对路径（规则 9） */
  fileExists: (relPath: string) => boolean;
}

export interface ValidateCardResult {
  ok: boolean;
  errors: CardIssue[];
  warnings: CardIssue[];
  resolved: {
    tags: string[];
    actions: string[];
    layout: { w: number; h: number; min_w: number; min_h: number } | null;
  };
}

/** 已知的契约版本 */
const KNOWN_API_VERSIONS = ['devboard/v1'] as const;

/** The grid a card may declare (12 columns). */
const GRID_COLUMNS = 12;

const PARAM_TYPES = ['integer', 'number', 'string', 'boolean', 'enum'] as const;

export function validateCard(manifest: CardManifest, ctx: ValidateCardContext): ValidateCardResult {
  const errors: CardIssue[] = [];
  const warnings: CardIssue[] = [];

  const error = (rule: number, path: string, message: string): void => {
    errors.push({ severity: 'error', rule, path, message });
  };
  const warn = (rule: number, path: string, message: string): void => {
    warnings.push({ severity: 'warning', rule, path, message });
  };

  /* ── 规则 1：apiVersion ── */
  if (!(KNOWN_API_VERSIONS as readonly string[]).includes(manifest.apiVersion)) {
    error(1, 'apiVersion', `unknown contract version "${manifest.apiVersion}"`);
  }

  /* ── 规则 2：id 全局唯一 ── */
  if (ctx.installedCardIds.includes(manifest.id)) {
    error(2, 'id', `a card with the id "${manifest.id}" is already installed`);
  }

  /* ── 规则 3：requires ⊆ permissions（按模式覆盖判定，契约 §2.2）──
     **逐项报**：只说「有一条没被覆盖」，人得自己去找是哪一条。 */
  const requires = manifest.requires ?? {};
  const perms = manifest.permissions;
  for (const tag of requires.tags ?? []) {
    if (!permissionCovers(perms, tag)) {
      error(3, 'requires.tags', `"${tag}" is not covered by permissions.read`);
    }
  }
  for (const actionId of requires.actions ?? []) {
    if (!perms.write.includes(actionId)) {
      error(3, 'requires.actions', `action "${actionId}" does not appear in permissions.write`);
    }
  }
  // **流程 id 同理**（评审 35 的 V2-C2 ✓）：
  // 声明了 `requires.workflows` 却没在 `permissions.workflows` 里覆盖 → **报错** ✓
  // （否则规则 3 有个例外口子 = 「愿望可以超出授权」✗）
  for (const workflowId of requires.workflows ?? []) {
    if (!(perms.workflows ?? []).includes(workflowId)) {
      error(3, 'requires.workflows', `workflow "${workflowId}" does not appear in permissions.workflows`);
    }
  }

  /* ── 规则 4：读权限里的 tag 必须在核心词表或 custom.* 下 ── */
  for (const tag of perms.read) {
    if (!isCoreTag(tag) && !tag.startsWith('custom.')) {
      error(4, 'permissions.read', `"${tag}" is neither in the core vocabulary nor under custom.*`);
    }
  }

  /* ── 规则 6：写权限不许通配符（契约 §2.3）──
     先查这条：通配的动作 id 报出来之后，规则 5 就别再报一遍「板型包里没有它」── */
  const writeIds: string[] = [];
  for (const id of perms.write) {
    if (id.includes('*')) {
      error(6, 'permissions.write', `write permissions only accept exact action ids, "${id}" is a wildcard`);
    } else {
      writeIds.push(id);
    }
  }

  /* ── 规则 5：写权限里的动作，当前板型包要有 ── */
  for (const id of writeIds) {
    if (ctx.availableActions === null) {
      warn(5, 'permissions.write', `action "${id}" is **unverified** (the board cannot be reached, so the board pack cannot be confirmed to have it)`);
    } else if (!ctx.availableActions.includes(id)) {
      error(5, 'permissions.write', `the current board pack has no action "${id}"`);
    }
  }

  /* ── 规则 14：流程权限只许精确 id，且**必须是宿主里已声明的流程** ──
     （契约 §九 的最后一条 ✓ —— 计划 7 补上 ✓）
     → 「通配」与写权限同款理由 ✓（§2.3 ✓）：写侧的通配会让授权范围变大 ✓
     → 「宿主里没有」与规则 5 同款处理 ✓：**离线时是警告** ✓（不是「不合法」✓） */
  const workflowIds: string[] = [];
  for (const id of perms.workflows ?? []) {
    if (id.includes('*')) {
      error(14, 'permissions.workflows', `workflow permissions only accept exact ids, "${id}" is a wildcard`);
    } else {
      workflowIds.push(id);
    }
  }
  for (const id of workflowIds) {
    if (ctx.availableWorkflows === null) {
      warn(14, 'permissions.workflows', `workflow "${id}" is **unverified** (offline, so the host cannot be confirmed to have it)`);
    } else if (!ctx.availableWorkflows.includes(id)) {
      error(14, 'permissions.workflows', `the host has no workflow "${id}"`);
    }
  }

  /* ── 规则 7 / 12：动作与写权限对得上 ── */
  for (const [index, action] of (manifest.actions ?? []).entries()) {
    if (action.target === undefined) {
      // 视图内动作：它**不碰板子**，所以不该出现在写权限里
      if (perms.write.includes(action.id)) {
        error(12, `actions[${index}].id`, `the view-local action "${action.id}" must not appear in permissions.write`);
      }
    } else if (!perms.write.includes(action.target)) {
      error(7, `actions[${index}].target`, `the board action "${action.target}" is not in permissions.write`);
    }
  }

  /* ── 规则 8：布局尺寸 ── */
  const layout = manifest.layout;
  if (layout !== undefined) {
    const w = layout.w ?? 3;
    const h = layout.h ?? 2;
    const minW = layout.min_w ?? 1;
    const minH = layout.min_h ?? 1;
    if (w < 1 || w > GRID_COLUMNS || h < 1) {
      error(8, 'layout', `w/h must be between 1 and ${GRID_COLUMNS} (got w=${w} h=${h})`);
    }
    if (minW > w || minH > h) {
      error(8, 'layout', `min_w/min_h must not be greater than w/h (got ${minW}×${minH} vs ${w}×${h})`);
    }
  }

  /* ── 规则 9：entry 文件存在 ── */
  if (!ctx.fileExists(manifest.entry)) {
    error(9, 'entry', `the entry file "${manifest.entry}" does not exist`);
  }

  /* ── 规则 11 / 13 的复查（结构性的两条，解析器已经挡过一道）── */
  for (const [index, action] of (manifest.actions ?? []).entries()) {
    const raw = action as unknown as Record<string, unknown>;
    for (const forbidden of ['danger', 'readback']) {
      if (forbidden in raw) {
        error(11, `actions[${index}].${forbidden}`, `a card must not declare ${forbidden} (that belongs to the board pack)`);
      }
    }
    for (const [key, param] of Object.entries(action.params ?? {})) {
      const p = param as unknown as Record<string, unknown>;
      const type = p['type'];
      if (typeof type !== 'string' || !(PARAM_TYPES as readonly string[]).includes(type)) {
        error(13, `actions[].params.${key}.type`, `unknown parameter type: ${String(type)}`);
      }
      if (type === 'string' && p['maxLength'] === undefined) {
        error(13, `actions[].params.${key}`, 'a string parameter must declare maxLength');
      }
    }
  }

  /* ── resolved：解析出来的清单 ── */
  const resolvedLayout =
    layout === undefined
      ? null
      : {
          w: layout.w ?? 3,
          h: layout.h ?? 2,
          min_w: layout.min_w ?? 1,
          min_h: layout.min_h ?? 1,
        };

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    resolved: {
      tags: [...perms.read],
      actions: [...perms.write],
      layout: resolvedLayout,
    },
  };
}

import { makeError } from '../../shared/errors';

/**
 * 卡片 manifest 的**封闭 schema**（契约 `spec/03` §2.5）。
 *
 * ── 为什么每一层都封闭 ──
 *
 * 被静默忽略的字段，就是**拼错的字段**。
 * 一张卡写 `"permissons": {...}`（少一个 i）→ 静默忽略 → 卡片**没有读权限**
 * → 什么都不显示，而作者**永远查不出原因**。
 *
 * 措辞与板型包加载器（`src/main/tags/pack.ts`）保持一致：
 * `卡片包 <source>：<位置>字段不认识（可能是拼错的）：<字段名>`
 */

export interface CardParamSchema {
  type: 'integer' | 'number' | 'string' | 'boolean' | 'enum';
  min?: number;
  max?: number;
  /** 字符串的长度上限。**`string` 必填**——没有上限的字符串参数就是注入面 */
  maxLength?: number;
  pattern?: string;
  /** `enum` 的取值（必填非空） */
  values?: string[];
  default?: unknown;
}

export interface CardActionDef {
  id: string;
  label: string;
  /** 板型包里的动作 id。**没有** = 视图内动作（不碰板子） */
  target?: string;
  params?: Record<string, CardParamSchema>;
}

export interface CardManifest {
  apiVersion: string;
  kind: 'Card';
  id: string;
  name: string;
  version: string;
  description?: string;
  entry: string;
  requires?: { tags?: string[]; actions?: string[]; workflows?: string[]; min_board_pack?: string };
  layout?: { w?: number; h?: number; min_w?: number; min_h?: number };
  permissions: { read: string[]; write: string[]; workflows?: string[] };
  actions?: CardActionDef[];
}

/* ── 白名单（契约 §2.5：每一层都封闭）── */

export const TOP_ALLOWED = [
  'apiVersion',
  'kind',
  'id',
  'name',
  'version',
  'description',
  'entry',
  'requires',
  'layout',
  'permissions',
  'actions',
] as const;

export const TOP_REQUIRED = ['apiVersion', 'kind', 'id', 'name', 'version', 'entry', 'permissions'] as const;

export const REQUIRES_ALLOWED = ['tags', 'actions', 'workflows', 'min_board_pack'] as const;
/**
 * `permissions` 的封闭字段表。
 *
 * → **`workflows` 在这里**（2026-11-15 加 ✓）：
 * 契约 §九 规则 3 说「requires ⊆ permissions」——
 * 而卡片声明 `requires.workflows` 就**必须**有一个 permissions 字段覆盖它 ✓，
 * 否则规则 3 无从判定 ✓（评审 35 的 V2-C2 ✓）。
 *
 * → **它为什么不是 `permissions.write`** ✓：
 * `permissions.write` 装的是**板型包里的动作 id** ✓，
 * 而规则 5/6 会对它做「在板型包里存在吗」「不许通配符」的检查 ✓——
 * **流程 id 不是动作 id** ✓ → 混进去会让那两条规则误判 ✓。
 */
export const PERMISSIONS_ALLOWED = ['read', 'write', 'workflows'] as const;
export const PERMISSIONS_REQUIRED = ['read', 'write'] as const;
export const LAYOUT_ALLOWED = ['w', 'h', 'min_w', 'min_h'] as const;
export const ACTION_ALLOWED = ['id', 'label', 'target', 'params'] as const;
export const ACTION_REQUIRED = ['id', 'label'] as const;
export const PARAM_ALLOWED = ['type', 'min', 'max', 'maxLength', 'pattern', 'values', 'default'] as const;

/** 参数类型的封闭取值（契约 §2.4 / §九 规则 13） */
export const PARAM_TYPES = ['integer', 'number', 'string', 'boolean', 'enum'] as const;

interface Ctx {
  source: string;
}

function fail(ctx: Ctx, message: string, detail?: Record<string, unknown>): never {
  throw makeError('PACK_INVALID', `card pack ${ctx.source}: ${message}`, {
    detail: { source: ctx.source, ...(detail ?? {}) },
  });
}

/** 未知字段必须报错（契约规则 10 / 11 / 13 的前半段） */
function checkKeys(
  ctx: Ctx,
  obj: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      const where = path ? `${path} ` : '';
      fail(ctx, `unknown field${where} (it may be misspelled): ${key}`, { path, field: key });
    }
  }
}

function requireKeys(
  ctx: Ctx,
  obj: Record<string, unknown>,
  path: string,
  required: readonly string[],
): void {
  for (const key of required) {
    if (!(key in obj) || obj[key] === undefined) {
      const where = path ? `${path} ` : '';
      fail(ctx, `${where}missing required field: ${key}`, { path, field: key });
    }
  }
}

function asObject(ctx: Ctx, value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(ctx, `${path} must be an object`, { path });
  }
  return value as Record<string, unknown>;
}

function asString(ctx: Ctx, value: unknown, path: string): string {
  if (typeof value !== 'string') fail(ctx, `${path} must be a string`, { path });
  return value;
}

function asNumber(ctx: Ctx, value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(ctx, `${path} must be a number`, { path });
  }
  return value;
}

function asStringArray(ctx: Ctx, value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(ctx, `${path} must be an array`, { path });
  return value.map((v, i) => asString(ctx, v, `${path}[${i}]`));
}

/** 解析一个参数的 schema（契约 §九 规则 13） */
function parseParam(ctx: Ctx, raw: unknown, path: string): CardParamSchema {
  const obj = asObject(ctx, raw, path);
  checkKeys(ctx, obj, path, PARAM_ALLOWED);
  requireKeys(ctx, obj, path, ['type']);
  const type = asString(ctx, obj['type'], `${path}.type`);
  if (!(PARAM_TYPES as readonly string[]).includes(type)) {
    fail(ctx, `${path}.type is unknown: ${type} (the closed value set: ${PARAM_TYPES.join(' / ')})`, {
      path,
      field: 'type',
    });
  }

  const param: CardParamSchema = { type: type as CardParamSchema['type'] };
  if (obj['min'] !== undefined) param.min = asNumber(ctx, obj['min'], `${path}.min`);
  if (obj['max'] !== undefined) param.max = asNumber(ctx, obj['max'], `${path}.max`);
  if (obj['maxLength'] !== undefined) {
    param.maxLength = asNumber(ctx, obj['maxLength'], `${path}.maxLength`);
  }
  if (obj['pattern'] !== undefined) param.pattern = asString(ctx, obj['pattern'], `${path}.pattern`);
  if (obj['default'] !== undefined) param.default = obj['default'];

  if (type === 'string') {
    // **没有上限的字符串参数就是注入面**（契约 §2.4）
    if (param.maxLength === undefined) {
      fail(ctx, `${path} is a string, it must declare maxLength (a string parameter without an upper bound is an injection surface)`, {
        path,
        field: 'maxLength',
      });
    }
  }
  if (type === 'enum') {
    if (obj['values'] === undefined) {
      fail(ctx, `${path} is an enum, it must declare values (the values are written down by the pack author and validated)`, {
        path,
        field: 'values',
      });
    }
    const values = asStringArray(ctx, obj['values'], `${path}.values`);
    if (values.length === 0) fail(ctx, `${path}.values must not be empty`, { path, field: 'values' });
    param.values = values;
  }
  return param;
}

/** 解析一个动作定义（契约 §五） */
function parseAction(ctx: Ctx, raw: unknown, path: string): CardActionDef {
  const obj = asObject(ctx, raw, path);
  checkKeys(ctx, obj, path, ACTION_ALLOWED);
  requireKeys(ctx, obj, path, ACTION_REQUIRED);
  const action: CardActionDef = {
    id: asString(ctx, obj['id'], `${path}.id`),
    label: asString(ctx, obj['label'], `${path}.label`),
  };
  if (obj['target'] !== undefined) {
    action.target = asString(ctx, obj['target'], `${path}.target`);
  }
  if (obj['params'] !== undefined) {
    const paramsObj = asObject(ctx, obj['params'], `${path}.params`);
    const params: Record<string, CardParamSchema> = {};
    for (const [key, value] of Object.entries(paramsObj)) {
      params[key] = parseParam(ctx, value, `${path}.params.${key}`);
    }
    action.params = params;
  }
  return action;
}

/**
 * 解析一张卡片的 manifest。
 *
 * @param source 卡片目录名（出现在错误信息里）
 * @throws 未知字段 / 缺必填字段 / 类型不对 —— **都抛错，不静默忽略**
 */
export function parseManifest(raw: unknown, source: string): CardManifest {
  const ctx: Ctx = { source };
  const obj = asObject(ctx, raw, '');
  checkKeys(ctx, obj, '', TOP_ALLOWED);
  requireKeys(ctx, obj, '', TOP_REQUIRED);

  const kind = asString(ctx, obj['kind'], 'kind');
  if (kind !== 'Card') fail(ctx, `kind must be Card (got ${kind})`, { path: 'kind' });

  const manifest: CardManifest = {
    apiVersion: asString(ctx, obj['apiVersion'], 'apiVersion'),
    kind: 'Card',
    id: asString(ctx, obj['id'], 'id'),
    name: asString(ctx, obj['name'], 'name'),
    version: asString(ctx, obj['version'], 'version'),
    entry: asString(ctx, obj['entry'], 'entry'),
    permissions: { read: [], write: [] },
  };
  if (obj['description'] !== undefined) {
    manifest.description = asString(ctx, obj['description'], 'description');
  }

  if (obj['requires'] !== undefined) {
    const requires = asObject(ctx, obj['requires'], 'requires');
    checkKeys(ctx, requires, 'requires', REQUIRES_ALLOWED);
    const r: NonNullable<CardManifest['requires']> = {};
    if (requires['tags'] !== undefined) r.tags = asStringArray(ctx, requires['tags'], 'requires.tags');
    if (requires['actions'] !== undefined) {
      r.actions = asStringArray(ctx, requires['actions'], 'requires.actions');
    }
    if (requires['workflows'] !== undefined) {
      r.workflows = asStringArray(ctx, requires['workflows'], 'requires.workflows');
    }
    if (requires['min_board_pack'] !== undefined) {
      r.min_board_pack = asString(ctx, requires['min_board_pack'], 'requires.min_board_pack');
    }
    manifest.requires = r;
  }

  if (obj['layout'] !== undefined) {
    const layout = asObject(ctx, obj['layout'], 'layout');
    checkKeys(ctx, layout, 'layout', LAYOUT_ALLOWED);
    const l: NonNullable<CardManifest['layout']> = {};
    if (layout['w'] !== undefined) l.w = asNumber(ctx, layout['w'], 'layout.w');
    if (layout['h'] !== undefined) l.h = asNumber(ctx, layout['h'], 'layout.h');
    if (layout['min_w'] !== undefined) l.min_w = asNumber(ctx, layout['min_w'], 'layout.min_w');
    if (layout['min_h'] !== undefined) l.min_h = asNumber(ctx, layout['min_h'], 'layout.min_h');
    manifest.layout = l;
  }

  const permissions = asObject(ctx, obj['permissions'], 'permissions');
  checkKeys(ctx, permissions, 'permissions', PERMISSIONS_ALLOWED);
  requireKeys(ctx, permissions, 'permissions', PERMISSIONS_REQUIRED);
  manifest.permissions = {
    read: asStringArray(ctx, permissions['read'], 'permissions.read'),
    write: asStringArray(ctx, permissions['write'], 'permissions.write'),
    ...(permissions['workflows'] === undefined
      ? {}
      : { workflows: asStringArray(ctx, permissions['workflows'], 'permissions.workflows') }),
  };

  if (obj['actions'] !== undefined) {
    if (!Array.isArray(obj['actions'])) fail(ctx, 'actions must be an array', { path: 'actions' });
    manifest.actions = obj['actions'].map((a, i) => parseAction(ctx, a, `actions[${i}]`));
  }

  return manifest;
}

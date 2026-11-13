import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { makeError } from '../../shared/errors';
import type {
  ActionDef,
  BoardPack,
  PackGuard,
  PackParam,
  PollGroupDef,
  ProvidesDef,
  ReadbackDef,
  ReaderDef,
} from './schema';

/**
 * 板型包的加载器。
 *
 * 契约：`docs/spec/02-board-pack.md` §一；规则 10 / 24（未知字段必须报错）。
 *
 * ── 这个模块管什么、不管什么 ──
 *
 * | 管 | 不管 |
 * |---|---|
 * | 字段**在不在**（未知字段报错） | 字段**对不对**（如 `match.mode` 是不是 exact/substring → 规则 11） |
 * | 字段的**类型**对不对 | `args` 里的**参数名**对不对（→ 规则 8，要问 kind 的 schema） |
 * | 必填字段**缺不缺** | 语义自洽（→ 27 条规则） |
 *
 * **为什么分这么清**：混在一起的后果很具体——
 * 「`stat_path` 拼错了」会被报成「包坏了」，
 * 而它其实是「这个 kind 的参数名写错了」。**修法完全不同**，
 * 报错的人（多半是写包的 agent）需要知道该改哪一处。
 *
 * ── 为什么不用 zod ──
 *
 * zod 默认**剥掉**未知键（不报错），而规则 10 要求**报错**。
 * 要报错得配 `.strict()`，那时错误消息是 zod 的形状——
 * 不如自己写「这个字段不认识，它可能是拼错的」。
 */

/** 顶层字段白名单（规则 10 / 24） */
const TOP_REQUIRED = [
  'apiVersion',
  'kind',
  'id',
  'name',
  'version',
  'requires',
  'poll_groups',
  'readers',
] as const;
const TOP_OPTIONAL = [
  'description',
  'danger_floor_version',
  'match',
  'custom',
  'actions',
] as const;

const REQUIRES_FIELDS = ['transports', 'capabilities', 'min_contract'] as const;
const MATCH_FIELDS = ['mode', 'models'] as const;
const GROUP_FIELDS = ['id', 'interval_ms', 'readers'] as const;
const READER_FIELDS = ['id', 'kind', 'args', 'provides'] as const;
const PROVIDES_FIELDS = ['tag', 'sample'] as const;
const ACTION_FIELDS = ['id', 'label', 'danger', 'params', 'guard', 'command', 'readback'] as const;
const PARAM_FIELDS = ['type', 'min', 'max', 'default', 'values', 'maxLength', 'pattern'] as const;
const GUARD_FIELDS = ['min', 'max'] as const;
const READBACK_FIELDS = [
  'tag',
  'expect',
  'kind',
  'path',
  'tolerance',
  'command',
  'timeout_ms',
  'consequence',
] as const;

/** 报错时的上下文 */
interface Ctx {
  /** 包的文件来源（给人看的） */
  source: string;
  /** 包 id（给人看的）。连 id 都没解析出来时用 source 顶上 */
  id: string;
}

function fail(ctx: Ctx, message: string, detail?: Record<string, unknown>): never {
  throw makeError('PACK_INVALID', `板型包 ${ctx.id}：${message}`, {
    detail: { source: ctx.source, ...(detail ?? {}) },
  });
}

/** 给「实际是什么」一句人话 */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '没有';
  if (Array.isArray(value)) return '列表';
  if (typeof value === 'object') return '一段（映射）';
  return typeof value;
}

function asObject(ctx: Ctx, value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(ctx, `${path} 必须是一段（映射），实际是 ${describe(value)}`, { path });
  }
  return value as Record<string, unknown>;
}

function asArray(ctx: Ctx, value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(ctx, `${path} 必须是列表，实际是 ${describe(value)}`, { path });
  }
  return value;
}

function asString(ctx: Ctx, value: unknown, path: string): string {
  if (typeof value !== 'string') {
    fail(ctx, `${path} 必须是字符串，实际是 ${describe(value)}`, { path });
  }
  return value;
}

function asNumber(ctx: Ctx, value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(ctx, `${path} 必须是数字，实际是 ${describe(value)}`, { path });
  }
  return value;
}

function asStringArray(ctx: Ctx, value: unknown, path: string): string[] {
  return asArray(ctx, value, path).map((v, i) => asString(ctx, v, `${path}[${i}]`));
}

/**
 * 未知字段必须报错（规则 10 / 24）。
 *
 * **被静默忽略的字段就是拼错的字段**——这正是这一条存在的理由。
 */
function checkKeys(
  ctx: Ctx,
  obj: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      const where = path ? `${path} ` : '';
      fail(ctx, `${where}字段不认识（可能是拼错的）：${key}`, { path, field: key });
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
      fail(ctx, `缺少必填字段 ${key}`, { path, field: key });
    }
  }
}

function parseProvides(ctx: Ctx, raw: unknown, path: string): ProvidesDef[] {
  return asArray(ctx, raw, path).map((item, i) => {
    const at = `${path}[${i}]`;
    const obj = asObject(ctx, item, at);
    checkKeys(ctx, obj, at, PROVIDES_FIELDS);
    requireKeys(ctx, obj, at, ['tag', 'sample']);
    return {
      tag: asString(ctx, obj['tag'], `${at}.tag`),
      sample: asString(ctx, obj['sample'], `${at}.sample`),
    };
  });
}

function parseReader(ctx: Ctx, raw: unknown, path: string): ReaderDef {
  const obj = asObject(ctx, raw, path);
  checkKeys(ctx, obj, path, READER_FIELDS);
  requireKeys(ctx, obj, path, ['id', 'kind', 'provides']);

  const argsRaw = obj['args'];
  const args =
    argsRaw === undefined
      ? undefined
      : asObject(ctx, argsRaw, `${path}.args`);

  return {
    id: asString(ctx, obj['id'], `${path}.id`),
    kind: asString(ctx, obj['kind'], `${path}.kind`),
    ...(args ? { args } : {}),
    provides: parseProvides(ctx, obj['provides'], `${path}.provides`),
  };
}

function parseGroup(ctx: Ctx, raw: unknown, path: string): PollGroupDef {
  const obj = asObject(ctx, raw, path);
  checkKeys(ctx, obj, path, GROUP_FIELDS);
  requireKeys(ctx, obj, path, ['id', 'interval_ms', 'readers']);
  return {
    id: asString(ctx, obj['id'], `${path}.id`),
    interval_ms: asNumber(ctx, obj['interval_ms'], `${path}.interval_ms`),
    readers: asStringArray(ctx, obj['readers'], `${path}.readers`),
  };
}

function parseParams(ctx: Ctx, raw: unknown, path: string): Record<string, PackParam> {
  const obj = asObject(ctx, raw, path);
  const out: Record<string, PackParam> = {};
  for (const [name, value] of Object.entries(obj)) {
    const at = `${path}.${name}`;
    const p = asObject(ctx, value, at);
    checkKeys(ctx, p, at, PARAM_FIELDS);
    requireKeys(ctx, p, at, ['type']);
    const param: PackParam = {
      type: asString(ctx, p['type'], `${at}.type`) as PackParam['type'],
    };
    if (p['min'] !== undefined) param.min = asNumber(ctx, p['min'], `${at}.min`);
    if (p['max'] !== undefined) param.max = asNumber(ctx, p['max'], `${at}.max`);
    if (p['default'] !== undefined) param.default = p['default'];
    if (p['values'] !== undefined) param.values = asStringArray(ctx, p['values'], `${at}.values`);
    if (p['maxLength'] !== undefined) {
      param.maxLength = asNumber(ctx, p['maxLength'], `${at}.maxLength`);
    }
    if (p['pattern'] !== undefined) param.pattern = asString(ctx, p['pattern'], `${at}.pattern`);
    out[name] = param;
  }
  return out;
}

function parseGuard(ctx: Ctx, raw: unknown, path: string): Record<string, PackGuard> {
  const obj = asObject(ctx, raw, path);
  const out: Record<string, PackGuard> = {};
  for (const [name, value] of Object.entries(obj)) {
    const at = `${path}.${name}`;
    const g = asObject(ctx, value, at);
    checkKeys(ctx, g, at, GUARD_FIELDS);
    const guard: PackGuard = {};
    if (g['min'] !== undefined) guard.min = asNumber(ctx, g['min'], `${at}.min`);
    if (g['max'] !== undefined) guard.max = asNumber(ctx, g['max'], `${at}.max`);
    out[name] = guard;
  }
  return out;
}

function parseReadback(ctx: Ctx, raw: unknown, path: string): ReadbackDef {
  const obj = asObject(ctx, raw, path);
  checkKeys(ctx, obj, path, READBACK_FIELDS);
  const out: ReadbackDef = {};
  if (obj['kind'] !== undefined) out.kind = asString(ctx, obj['kind'], `${path}.kind`);
  if (obj['tag'] !== undefined) out.tag = asString(ctx, obj['tag'], `${path}.tag`);
  if (obj['expect'] !== undefined) out.expect = obj['expect'];
  if (obj['path'] !== undefined) out.path = asString(ctx, obj['path'], `${path}.path`);
  if (obj['tolerance'] !== undefined) out.tolerance = asNumber(ctx, obj['tolerance'], `${path}.tolerance`);
  if (obj['command'] !== undefined) out.command = asString(ctx, obj['command'], `${path}.command`);
  if (obj['timeout_ms'] !== undefined) {
    out.timeout_ms = asNumber(ctx, obj['timeout_ms'], `${path}.timeout_ms`);
  }
  if (obj['consequence'] !== undefined) {
    out.consequence = asString(ctx, obj['consequence'], `${path}.consequence`);
  }
  return out;
}

function parseAction(ctx: Ctx, raw: unknown, path: string): ActionDef {
  const obj = asObject(ctx, raw, path);
  checkKeys(ctx, obj, path, ACTION_FIELDS);
  requireKeys(ctx, obj, path, ['id', 'danger', 'command']);

  const danger = asString(ctx, obj['danger'], `${path}.danger`);
  if (danger !== 'reversible' && danger !== 'destructive') {
    // 契约 §4.2：**只有两档**。这里不是「27 条规则」之一，
    // 但它是**类型**的一部分——`danger` 的取值域写死在类型里。
    fail(ctx, `${path}.danger 只能是 reversible 或 destructive，实际是「${danger}」`, {
      path: `${path}.danger`,
    });
  }

  const action: ActionDef = {
    id: asString(ctx, obj['id'], `${path}.id`),
    danger,
    command: asString(ctx, obj['command'], `${path}.command`),
  };
  if (obj['label'] !== undefined) action.label = asString(ctx, obj['label'], `${path}.label`);
  if (obj['params'] !== undefined) action.params = parseParams(ctx, obj['params'], `${path}.params`);
  if (obj['guard'] !== undefined) action.guard = parseGuard(ctx, obj['guard'], `${path}.guard`);
  if (obj['readback'] !== undefined) {
    action.readback = parseReadback(ctx, obj['readback'], `${path}.readback`);
  }
  return action;
}

/**
 * 解析一份板型包。
 *
 * @param text  YAML 原文
 * @param source 文件来源（报错时给人看）
 */
export function parseBoardPack(text: string, source = 'board.yaml'): BoardPack {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw makeError('PACK_INVALID', `板型包 ${source}：YAML 解析失败——${String(err)}`, {
      detail: { source },
    });
  }

  if (raw === undefined || raw === null) {
    throw makeError('PACK_INVALID', `板型包 ${source}：文件是空的`, { detail: { source } });
  }

  const obj = asObject({ source, id: source }, raw, '');
  // id 先挑出来，好让后面的报错消息带上包名
  const id = typeof obj['id'] === 'string' ? obj['id'] : source;
  const ctx: Ctx = { source, id };

  checkKeys(ctx, obj, '', [...TOP_REQUIRED, ...TOP_OPTIONAL]);
  requireKeys(ctx, obj, '', TOP_REQUIRED);

  const kind = asString(ctx, obj['kind'], 'kind');
  if (kind !== 'BoardPack') {
    fail(ctx, `kind 必须是 BoardPack，实际是「${kind}」`, { path: 'kind' });
  }

  const requiresRaw = asObject(ctx, obj['requires'], 'requires');
  checkKeys(ctx, requiresRaw, 'requires', REQUIRES_FIELDS);
  requireKeys(ctx, requiresRaw, 'requires', ['transports', 'capabilities']);
  const requires: BoardPack['requires'] = {
    transports: asStringArray(ctx, requiresRaw['transports'], 'requires.transports'),
    capabilities: asStringArray(ctx, requiresRaw['capabilities'], 'requires.capabilities'),
  };
  if (requiresRaw['min_contract'] !== undefined) {
    requires.min_contract = asString(ctx, requiresRaw['min_contract'], 'requires.min_contract');
  }

  const pack: BoardPack = {
    apiVersion: asString(ctx, obj['apiVersion'], 'apiVersion'),
    kind: 'BoardPack',
    id,
    name: asString(ctx, obj['name'], 'name'),
    version: asString(ctx, obj['version'], 'version'),
    requires,
    poll_groups: asArray(ctx, obj['poll_groups'], 'poll_groups').map((r, i) =>
      parseGroup(ctx, r, `poll_groups[${i}]`),
    ),
    readers: asArray(ctx, obj['readers'], 'readers').map((r, i) =>
      parseReader(ctx, r, `readers[${i}]`),
    ),
    custom: [],
    actions: [],
  };

  if (obj['description'] !== undefined) {
    pack.description = asString(ctx, obj['description'], 'description');
  }
  if (obj['danger_floor_version'] !== undefined) {
    pack.danger_floor_version = asNumber(ctx, obj['danger_floor_version'], 'danger_floor_version');
  }
  if (obj['match'] !== undefined) {
    const m = asObject(ctx, obj['match'], 'match');
    checkKeys(ctx, m, 'match', MATCH_FIELDS);
    requireKeys(ctx, m, 'match', ['mode', 'models']);
    pack.match = {
      mode: asString(ctx, m['mode'], 'match.mode'),
      models: asStringArray(ctx, m['models'], 'match.models'),
    };
  }
  if (obj['custom'] !== undefined) {
    pack.custom = asArray(ctx, obj['custom'], 'custom').map((r, i) =>
      parseReader(ctx, r, `custom[${i}]`),
    );
  }
  if (obj['actions'] !== undefined) {
    pack.actions = asArray(ctx, obj['actions'], 'actions').map((a, i) =>
      parseAction(ctx, a, `actions[${i}]`),
    );
  }

  return pack;
}

/**
 * 从一个包目录加载板型包（读 `<dir>/board.yaml`）。
 */
export function loadBoardPack(dir: string): BoardPack {
  const file = join(dir, 'board.yaml');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw makeError('PACK_INVALID', `板型包 ${dir}：找不到 ${file}`, {
      detail: { dir, file },
    });
  }
  return parseBoardPack(text, file);
}

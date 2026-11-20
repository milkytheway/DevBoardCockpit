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
 * The loader of a board pack.
 *
 * Contract: `docs/spec/02-board-pack.md` section 1; rules 10 / 24 (an
 * unknown field must be an error).
 *
 * ── What this module does and does not do ──
 *
 * | It does | It does not |
 * |---|---|
 * | whether a field is there (an unknown field is an error) | whether a field is right (for example whether `match.mode` is exact or substring → rule 11) |
 * | whether the type of a field is right | whether the argument names inside `args` are right (→ rule 8, which asks the schema of the kind) |
 * | whether a required field is missing | whether it is semantically consistent (→ the 27 rules) |
 *
 * Why the split is this clean: the consequence of mixing them is very
 * concrete — "stat_path is misspelled" would be reported as "the pack is
 * broken", while it really is "the argument name of this kind is wrong". The
 * fix is completely different, and whoever reads the error (most of the
 * time the agent that wrote the pack) has to know which place to change.
 *
 * ── Why not zod ──
 *
 * zod drops unknown keys by default (no error), while rule 10 requires an
 * error. Getting an error means configuring `.strict()`, and then the error
 * messages have zod's shape — it is easier to write "this field is not
 * known, it may be misspelled" by hand.
 */

/** The allow list of the top-level fields (rules 10 / 24) */
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

/** The context used when reporting an error */
interface Ctx {
  /** Where the file of the pack came from (for the reader) */
  source: string;
  /** The id of the pack (for the reader). Used when even the id could not be parsed */
  id: string;
}

function fail(ctx: Ctx, message: string, detail?: Record<string, unknown>): never {
  throw makeError('PACK_INVALID', `board pack ${ctx.id}: ${message}`, {
    detail: { source: ctx.source, ...(detail ?? {}) },
  });
}

/** One plain sentence about what a value actually is */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'none';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a mapping';
  return typeof value;
}

function asObject(ctx: Ctx, value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(ctx, `${path} must be a mapping, it is ${describe(value)}`, { path });
  }
  return value as Record<string, unknown>;
}

function asArray(ctx: Ctx, value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(ctx, `${path} must be a list, it is ${describe(value)}`, { path });
  }
  return value;
}

function asString(ctx: Ctx, value: unknown, path: string): string {
  if (typeof value !== 'string') {
    fail(ctx, `${path} must be a string, it is ${describe(value)}`, { path });
  }
  return value;
}

function asNumber(ctx: Ctx, value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(ctx, `${path} must be a number, it is ${describe(value)}`, { path });
  }
  return value;
}

function asStringArray(ctx: Ctx, value: unknown, path: string): string[] {
  return asArray(ctx, value, path).map((v, i) => asString(ctx, v, `${path}[${i}]`));
}

/**
 * An unknown field must be an error (rules 10 / 24).
 *
 * A field that is silently ignored is a field that is misspelled — that is
 * exactly why this rule exists.
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
      fail(ctx, `missing required field ${key}`, { path, field: key });
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
    // Contract section 4.2: there are only two grades. This is not one of
    // the 27 rules, but it is part of the type — the domain of `danger` is
    // written into the type.
    fail(ctx, `${path}.danger must be reversible or destructive, it is "${danger}"`, {
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
 * Parse a board pack.
 *
 * @param text  the YAML source
 * @param source where the file came from (shown when reporting an error)
 */
export function parseBoardPack(text: string, source = 'board.yaml'): BoardPack {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw makeError('PACK_INVALID', `board pack ${source}: YAML parsing failed — ${String(err)}`, {
      detail: { source },
    });
  }

  if (raw === undefined || raw === null) {
    throw makeError('PACK_INVALID', `board pack ${source}: the file is empty`, { detail: { source } });
  }

  const obj = asObject({ source, id: source }, raw, '');
  // The id is picked out first, so that the later error messages carry the name of the pack
  const id = typeof obj['id'] === 'string' ? obj['id'] : source;
  const ctx: Ctx = { source, id };

  checkKeys(ctx, obj, '', [...TOP_REQUIRED, ...TOP_OPTIONAL]);
  requireKeys(ctx, obj, '', TOP_REQUIRED);

  const kind = asString(ctx, obj['kind'], 'kind');
  if (kind !== 'BoardPack') {
    fail(ctx, `kind must be BoardPack, it is "${kind}"`, { path: 'kind' });
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
 * Load a board pack from a pack directory (reads `<dir>/board.yaml`).
 */

export function loadBoardPack(dir: string): BoardPack {
  const file = join(dir, 'board.yaml');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw makeError('PACK_INVALID', `board pack ${dir}: ${file} not found`, {
      detail: { dir, file },
    });
  }
  return parseBoardPack(text, file);
}

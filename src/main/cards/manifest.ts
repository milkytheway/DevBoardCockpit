import { makeError } from '../../shared/errors';

/**
 * The **closed schema** of a card manifest (contract `spec/03` §2.5).
 *
 * ── Why every layer is closed ──
 *
 * A field that is silently ignored is a **field that was misspelled**.
 * A card that writes `"permissons": {...}` (one i missing) → silently ignored →
 * the card has **no read permission** → nothing is displayed and the author
 * **never finds out why**.
 *
 * The wording is kept consistent with the board pack loader
 * (`src/main/tags/pack.ts`):
 * `card pack <source>: unknown field <path> (it may be misspelled): <field>`
 */

export interface CardParamSchema {
  type: 'integer' | 'number' | 'string' | 'boolean' | 'enum';
  min?: number;
  max?: number;
  /** The upper bound of a string length. **`string` is mandatory** — a string parameter without an upper bound is an injection surface */
  maxLength?: number;
  pattern?: string;
  /** The values of an `enum` (mandatory, not empty) */
  values?: string[];
  default?: unknown;
}

export interface CardActionDef {
  id: string;
  label: string;
  /** An action id of a board pack. **Absent** = an in-view action (it does not touch the board) */
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

/* ── The allow list (contract §2.5: every layer is closed) ── */

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
 * The closed field table of `permissions`.
 *
 * → **`workflows` lives here** (added 2026-11-15 ✓):
 * rule 3 of contract §9 says "requires ⊆ permissions" — and a card that
 * declares `requires.workflows` **must** have a permissions field that covers
 * it ✓, otherwise rule 3 cannot be judged ✓ (review 35, V2-C2 ✓).
 *
 * → **Why it is not `permissions.write`** ✓:
 * `permissions.write` holds the **action ids of a board pack** ✓, and rules
 * 5/6 check it for "does it exist in the board pack" and "no wildcards" ✓ —
 * **a workflow id is not an action id** ✓ → mixing them in would make those
 * two rules misjudge ✓.
 */
export const PERMISSIONS_ALLOWED = ['read', 'write', 'workflows'] as const;
export const PERMISSIONS_REQUIRED = ['read', 'write'] as const;
export const LAYOUT_ALLOWED = ['w', 'h', 'min_w', 'min_h'] as const;
export const ACTION_ALLOWED = ['id', 'label', 'target', 'params'] as const;
export const ACTION_REQUIRED = ['id', 'label'] as const;
export const PARAM_ALLOWED = ['type', 'min', 'max', 'maxLength', 'pattern', 'values', 'default'] as const;

/** The closed values of a parameter type (contract §2.4 / §9 rule 13) */
export const PARAM_TYPES = ['integer', 'number', 'string', 'boolean', 'enum'] as const;

interface Ctx {
  source: string;
}

function fail(ctx: Ctx, message: string, detail?: Record<string, unknown>): never {
  throw makeError('PACK_INVALID', `card pack ${ctx.source}: ${message}`, {
    detail: { source: ctx.source, ...(detail ?? {}) },
  });
}

/** An unknown field must be an error (the first half of contract rules 10 / 11 / 13) */
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

/**
 * **The shape of a card id** ✓ — a **closed** one ✓.
 *
 * → The id is **the name of the card's directory** ✓ → the host builds a
 *   path from it ✓ → an id that may carry ".." ✓ or a separator ✓ is
 *   **a deletion outside the card root** ✓ (found on 2026-11-21 ✓:
 *   `install_card` deleted the user data directory ✓ because the manifest
 *   said `"id": ".."` ✓).
 * → So the id is **a name** ✓ — lowercase ✓ · digits ✓ · hyphens ✓ — and
 *   nothing else ✓ (contract §9 rule 2 ✓).
 */
export const CARD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Is this id a safe directory name? ✓ */
export function isSafeCardId(id: string): boolean {
  return CARD_ID_PATTERN.test(id);
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

/** Parses the schema of one parameter (contract §9 rule 13) */
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
    // **A string parameter without an upper bound is an injection surface** (contract §2.4)
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

/** Parses one action definition (contract §5) */
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
 * Parses the manifest of a card.
 *
 * @param source the name of the card directory (it appears in the error message)
 * @throws an unknown field / a missing mandatory field / a wrong type — **all
 *         of them throw, nothing is ignored silently**
 */
export function parseManifest(raw: unknown, source: string): CardManifest {
  const ctx: Ctx = { source };
  const obj = asObject(ctx, raw, '');
  checkKeys(ctx, obj, '', TOP_ALLOWED);
  requireKeys(ctx, obj, '', TOP_REQUIRED);

  const kind = asString(ctx, obj['kind'], 'kind');
  if (kind !== 'Card') fail(ctx, `kind must be Card (got ${kind})`, { path: 'kind' });

  // → **The id is a directory name** ✓ → it has to be a safe one ✓ (the
  //   host deletes and writes paths built from it ✓).
  const id = asString(ctx, obj['id'], 'id');
  if (!isSafeCardId(id)) {
    fail(
      ctx,
      `the id must be a name of letters, digits and hyphens (${CARD_ID_PATTERN.source}) — it is the name of a directory ✓`,
      { path: 'id' },
    );
  }

  const manifest: CardManifest = {
    apiVersion: asString(ctx, obj['apiVersion'], 'apiVersion'),
    kind: 'Card',
    id,
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

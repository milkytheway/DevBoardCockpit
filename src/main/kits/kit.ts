/**
 * The **board kit** — everything one board model needs to be used ✓
 * (contract `docs/spec/06-board-kit.md` ✓).
 *
 * ── What it solves ──
 *
 * → A connection profile carries values that belong to **one machine and one
 *   board** ✓ (the serial port ✓ · the board's serial number ✓ · the
 *   address ✓).
 * → A published repository must not carry them ✓ → the shipped profiles could
 *   only carry placeholders ✓ → **a placeholder profile is a profile that
 *   cannot connect** ✓.
 * → A kit replaces the placeholder profile with a **template** ✓ — the person
 *   fills the variables once ✓ — and the host writes a concrete profile ✓.
 *
 * ── The shape of it ──
 *
 * ```
 * profiles/kits/<kit-id>/
 *   kit.yaml                 # the manifest ✓
 *   connections/
 *     <profile-id>.json      # a connection template ✓
 * ```
 *
 * → **The templates are not profiles** ✓ — the profile loader never sees them
 * ✓ (they live in another directory ✓) — and `parseProfile` must not accept
 * them ✓ (the substituted result is validated again ✓).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { makeError } from '../../shared/errors';
import { parseProfile, type ConnectionProfile } from '../profiles/schema';

/** The version of the contract layer this file belongs to ✓ */
const KNOWN_API_VERSION = 'devboard/v1';

/** The variable types ✓ (the same closed table the workflow pack's inputs use ✓) */
export const VARIABLE_TYPES = [
  'string',
  'integer',
  'number',
  'boolean',
  'enum',
  'path',
] as const;

export type VariableType = (typeof VARIABLE_TYPES)[number];

/** One variable the person has to fill in ✓ */
export interface KitVariable {
  type: VariableType;
  label: string;
  required: boolean;
  default?: unknown;
  description?: string;
  /** For `enum` ✓ — the closed list of the values ✓ */
  values?: string[];
}

/** One connection template ✓ */
export interface KitConnection {
  /** The profile id the template produces ✓ */
  id: string;
  /** The template itself ✓ (a profile with placeholders in it ✓) */
  profile: Record<string, unknown>;
  /** The placeholders it uses ✓ */
  placeholders: string[];
}

/** One kit ✓ */
export interface BoardKit {
  id: string;
  /** What the board reports ✓ */
  model: string;
  /** How the model is matched ✓ (the two modes of the board pack's `match` ✓) */
  match: 'exact' | 'substring';
  /** The board pack this kit is for ✓ (`null` = the host provides it ✓) */
  board_pack: string | null;
  /** The identity of the board ✓ */
  device_key: string | null;
  workflows: string[];
  cards: string[];
  variables: Record<string, KitVariable>;
  connections: KitConnection[];
}

function fail(message: string, source: string, detail?: unknown): never {
  throw makeError('IPC_INVALID_PAYLOAD', message, {
    detail: { source, ...(detail === undefined ? {} : { detail }) },
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The closed field list of the manifest ✓ (an unknown field is an error ✓) */
const MANIFEST_KEYS = [
  'apiVersion',
  'kind',
  'id',
  'model',
  'match',
  'board_pack',
  'device_key',
  'workflows',
  'cards',
  'variables',
] as const;

const VARIABLE_KEYS = ['type', 'label', 'required', 'default', 'description', 'values'] as const;

function parseVariable(raw: unknown, name: string, source: string): KitVariable {
  if (!isRecord(raw)) fail(`the variable "${name}" must be an object`, source);
  for (const key of Object.keys(raw)) {
    if (!(VARIABLE_KEYS as readonly string[]).includes(key)) {
      fail(`unknown field "${key}" in the variable "${name}"`, source, { key });
    }
  }
  const type = raw['type'];
  if (typeof type !== 'string' || !VARIABLE_TYPES.includes(type as VariableType)) {
    fail(
      `the type of the variable "${name}" must be one of ${VARIABLE_TYPES.join(' / ')}`,
      source,
    );
  }
  const label = raw['label'];
  if (typeof label !== 'string' || label.length === 0) {
    fail(`the variable "${name}" needs a label`, source);
  }
  const required = raw['required'];
  if (required !== undefined && typeof required !== 'boolean') {
    fail(`"required" of the variable "${name}" must be a boolean`, source);
  }
  const values = raw['values'];
  if (values !== undefined && !Array.isArray(values)) {
    fail(`"values" of the variable "${name}" must be a list`, source);
  }
  return {
    type: type as VariableType,
    label,
    required: required === true,
    ...(raw['default'] === undefined ? {} : { default: raw['default'] }),
    ...(raw['description'] === undefined ? {} : { description: String(raw['description']) }),
    ...(values === undefined ? {} : { values: values.map(String) }),
  };
}

/** Parses one manifest ✓ (the field list is closed ✓) */
export function parseKitManifest(raw: unknown, source: string): Omit<BoardKit, 'connections'> {
  if (!isRecord(raw)) fail('a kit manifest must be an object', source);
  for (const key of Object.keys(raw)) {
    if (!(MANIFEST_KEYS as readonly string[]).includes(key)) {
      fail(`unknown field "${key}"`, source, { key });
    }
  }
  if (raw['apiVersion'] !== KNOWN_API_VERSION) {
    fail(`apiVersion must be ${KNOWN_API_VERSION}`, source);
  }
  if (raw['kind'] !== 'BoardKit') fail('kind must be BoardKit', source);

  const id = raw['id'];
  if (typeof id !== 'string' || id.length === 0) fail('id must be a non-empty string', source);
  const model = raw['model'];
  if (typeof model !== 'string' || model.length === 0) {
    fail('model must be a non-empty string', source);
  }
  const match = raw['match'] ?? 'exact';
  if (match !== 'exact' && match !== 'substring') {
    fail('match must be exact or substring', source);
  }
  const boardPack = raw['board_pack'];
  if (boardPack !== undefined && boardPack !== null && typeof boardPack !== 'string') {
    fail('board_pack must be a string or null', source);
  }
  const deviceKey = raw['device_key'];
  if (deviceKey !== undefined && deviceKey !== null && typeof deviceKey !== 'string') {
    fail('device_key must be a string or null', source);
  }
  const workflows = raw['workflows'] ?? [];
  const cards = raw['cards'] ?? [];
  if (!Array.isArray(workflows) || !Array.isArray(cards)) {
    fail('workflows and cards must be lists', source);
  }
  const variablesRaw = raw['variables'] ?? {};
  if (!isRecord(variablesRaw)) fail('variables must be an object', source);
  const variables: Record<string, KitVariable> = {};
  for (const [name, value] of Object.entries(variablesRaw)) {
    variables[name] = parseVariable(value, name, source);
  }

  return {
    id,
    model,
    match,
    board_pack: (boardPack as string | null | undefined) ?? null,
    device_key: (deviceKey as string | null | undefined) ?? null,
    workflows: workflows.map(String),
    cards: cards.map(String),
    variables,
  };
}

/** The placeholders a text uses ✓ (`${name}` and nothing else ✓) */
export function placeholdersOf(text: string): string[] {
  const out: string[] = [];
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  let m = re.exec(text);
  while (m !== null) {
    if (!out.includes(m[1] ?? '')) out.push(m[1] ?? '');
    m = re.exec(text);
  }
  return out;
}

/** Walks a value and collects the placeholders ✓ */
function collect(value: unknown, into: string[]): void {
  if (typeof value === 'string') {
    for (const p of placeholdersOf(value)) if (!into.includes(p)) into.push(p);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, into);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collect(item, into);
  }
}

/**
 * Replaces the placeholders with the answers ✓.
 *
 * → **The type decides** ✓ (the table of `05` §2 ✓) — a number that arrives as
 * a string is an error ✓, not a profile that fails later ✓.
 * → **A leftover placeholder is an error** ✓ (contract rule 7 ✓).
 */
export function substitute(
  value: unknown,
  answers: Record<string, unknown>,
  variables: Record<string, KitVariable>,
  where: string,
): unknown {
  if (typeof value === 'string') {
    const names = placeholdersOf(value);
    if (names.length === 0) return value;
    // **The whole string is one placeholder** → the type decides the result ✓
    if (names.length === 1 && value === `\${${names[0]}}`) {
      const name = names[0] ?? '';
      const answer = answers[name];
      if (answer === undefined) {
        const variable = variables[name];
        if (variable === undefined) {
          fail(`the placeholder "\${${name}}" is not declared in the variables`, where);
        }
        if (variable.default === undefined) {
          fail(`the variable "${name}" has no value and no default`, where);
        }
        return checkType(variable.default, variable, name, where);
      }
      return checkType(answer, variables[name] ?? { type: 'string', label: name, required: false }, name, where);
    }
    // **A placeholder inside a longer text** → the text stays a string ✓
    let out = value;
    for (const name of names) {
      const answer = answers[name];
      if (answer === undefined) {
        fail(`the variable "${name}" has no value`, where);
      }
      out = out.replaceAll(`\${${name}}`, String(answer));
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substitute(item, answers, variables, where));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = substitute(item, answers, variables, where);
    }
    return out;
  }
  return value;
}

function checkType(
  value: unknown,
  variable: KitVariable,
  name: string,
  where: string,
): unknown {
  switch (variable.type) {
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail(`the variable "${name}" must be a ${variable.type}`, where, { value });
      }
      if (variable.type === 'integer' && !Number.isInteger(value)) {
        fail(`the variable "${name}" must be an integer`, where, { value });
      }
      return value;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        fail(`the variable "${name}" must be a boolean`, where, { value });
      }
      return value;
    }
    case 'enum': {
      if (typeof value !== 'string' || !(variable.values ?? []).includes(value)) {
        fail(`the variable "${name}" must be one of ${(variable.values ?? []).join(' / ')}`, where, {
          value,
        });
      }
      return value;
    }
    default: {
      if (typeof value !== 'string') {
        fail(`the variable "${name}" must be a string`, where, { value });
      }
      return value;
    }
  }
}

/** Reads one kit directory ✓ */
export function loadKit(dir: string): BoardKit {
  const manifestPath = join(dir, 'kit.yaml');
  if (!existsSync(manifestPath)) {
    fail(`there is no kit.yaml in ${dir}`, manifestPath);
  }
  const parsed = yaml.load(readFileSync(manifestPath, 'utf8')) as unknown;
  const manifest = parseKitManifest(parsed, manifestPath);

  const connectionsDir = join(dir, 'connections');
  const connections: KitConnection[] = [];
  if (existsSync(connectionsDir)) {
    for (const file of readdirSync(connectionsDir).filter((f) => f.endsWith('.json')).sort()) {
      const path = join(connectionsDir, file);
      const profile = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (!isRecord(profile)) fail(`the template ${path} must be an object`, path);
      const id = profile['id'];
      if (typeof id !== 'string' || id.length === 0) {
        fail(`the template ${path} needs an id`, path);
      }
      const found: string[] = [];
      collect(profile, found);
      connections.push({ id, profile, placeholders: found });
    }
  }

  // **Every placeholder must be declared** ✓ (contract rule 5 ✓)
  for (const connection of connections) {
    for (const name of connection.placeholders) {
      if (manifest.variables[name] === undefined) {
        fail(
          `the template "${connection.id}" uses "\${${name}}" but the kit does not declare it`,
          manifestPath,
        );
      }
    }
  }
  // **Every declared variable must be used** ✓ (a variable nobody uses is a typo ✓)
  const used = new Set(connections.flatMap((c) => c.placeholders));
  for (const name of Object.keys(manifest.variables)) {
    if (!used.has(name)) {
      fail(`the variable "${name}" is declared but no template uses it`, manifestPath);
    }
  }

  return { ...manifest, connections };
}

/** Reads every kit in a directory ✓ (the ones whose id is the directory name ✓) */
export function loadKits(kitsDir: string): BoardKit[] {
  if (!existsSync(kitsDir)) return [];
  const out: BoardKit[] = [];
  for (const entry of readdirSync(kitsDir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (!entry.isDirectory()) continue;
    const dir = join(kitsDir, entry.name);
    if (!existsSync(join(dir, 'kit.yaml'))) continue;
    const kit = loadKit(dir);
    if (kit.id !== entry.name) {
      fail(`the kit id "${kit.id}" is not the directory name "${entry.name}"`, dir);
    }
    out.push(kit);
  }
  return out;
}

/** The kits whose model matches ✓ — **never a guess** ✓ (contract rule 9 ✓) */
export function kitsForModel(kits: readonly BoardKit[], model: string): BoardKit[] {
  const target = model.trim();
  if (target.length === 0) return [];
  return kits.filter((kit) =>
    kit.match === 'exact' ? kit.model === target : target.includes(kit.model),
  );
}

/** The result of installing a kit ✓ */
export interface InstallResult {
  /** The profiles that were written ✓ */
  written: string[];
  /** The ones that were already there ✓ (**installing never destroys ✓**) */
  kept: string[];
  /** The variables that had no value ✓ (**the host says so ✓**) */
  missing: string[];
}

/**
 * Installs a kit: the templates become concrete profiles in the **user profile
 * directory** ✓ (contract rule 11 ✓).
 *
 * → **A profile that is already there is not overwritten** ✓ (rule 14 ✓).
 * → **The result is validated again** ✓ (rule 7 ✓) — a leftover placeholder
 *   or a field of the wrong type is an error **here** ✓, not a connection that
 *   fails later ✓.
 */
export function installKit(
  kit: BoardKit,
  answers: Record<string, unknown>,
  userProfilesDir: string,
): InstallResult {
  const written: string[] = [];
  const kept: string[] = [];
  const missing: string[] = [];

  for (const name of Object.keys(kit.variables)) {
    const variable = kit.variables[name];
    if (variable === undefined) continue;
    if (answers[name] === undefined && variable.default === undefined && variable.required) {
      missing.push(name);
    }
  }

  // → **A variable that has no value is reported** ✓ (the person fills it in
  //   ✓) — it does **not** stop the other templates ✓ (the board's adb
  //   connection can be installed before the key is known ✓).
  mkdirSync(userProfilesDir, { recursive: true });
  for (const connection of kit.connections) {
    const target = join(userProfilesDir, `${connection.id}.json`);
    if (existsSync(target)) {
      kept.push(connection.id);
      continue;
    }
    let substituted: unknown;
    try {
      substituted = substitute(connection.profile, answers, kit.variables, connection.id);
    } catch {
      // → **The template needs a variable that has no value** ✓ → it is not
      //   installed ✓ (the person fills it in ✓ → and installs again ✓).
      continue;
    }
    const text = JSON.stringify(substituted);
    if (text.includes('${')) {
      fail(`the profile "${connection.id}" still has a placeholder in it`, connection.id);
    }
    // **It is validated again** ✓ (rule 7 ✓) — the schema is the authority ✓
    const profile: ConnectionProfile = parseProfile(substituted, connection.id);
    writeFileSync(target, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
    written.push(connection.id);
  }
  return { written, kept, missing };
}

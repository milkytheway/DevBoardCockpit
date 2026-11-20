import { makeError } from '../../shared/errors';
import { PLACEMENT_IDS, isPlacement } from './placement';

/**
 * The format and the validator of a workflow pack — a host-level format.
 *
 * > ⚠️ It is not the contract: not one character of the five documents
 * > in `docs/spec/` changes (ADR-D31 R1).
 * > The first version of the workflow pack is a host-level data format
 * > (`fixtures/`); only after two workflows have run on a real board is
 * > there talk of promoting it to the contract.
 *
 * ── What it answers ──
 *
 * | Pack | Answers |
 * |---|---|
 * | Board pack | what this board has (which quantities it can produce, which writes it accepts) |
 * | Workflow pack | how this task is done (several targets, several steps, with criteria) |
 *
 * ── The three design floors ──
 *
 * 1. A closed schema: an unknown field is always an error. A
 *    workflow pack is a declaration — a misspelled field that is
 *    silently ignored means the workflow runs as before, only one thing
 *    less happens, or it happens on the wrong target.
 * 2. There are only 6 step kinds (ADR-D31 R11): `exec` / `file.transfer`
 *    / `action` / `await` / `assert` / `discover`. `exec_script` does not
 *    even get "a place reserved".
 * 3. The criteria reuse the five readback forms of M6 (ADR-D31 R3) —
 *    no sixth form is added, there is only one more "on which role it
 *    is read" (the verification across targets depends on it).
 */

/** The closed type table of the inputs (following `spec/02` section 4.3 — not a second one) */
export const INPUT_TYPES = ['string', 'integer', 'number', 'boolean', 'enum', 'path'] as const;
export type WorkflowInputType = (typeof INPUT_TYPES)[number];

export interface WorkflowInputDef {
  type: WorkflowInputType;
  required?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  /** Only for `enum`: the allowed values (closed) */
  values?: string[];
  /**
   * The default value (it is used when the caller gives none — `spec/02`
   * section 4.3).
   *
   * → The host prefills the common inputs (a card can be run with one
   *   click).
   * → It has to pass the value check of its own type (it has to be
   *   valid itself).
   */
  default?: unknown;
  /**
   * The shape constraint for `string` (a regular expression — the second
   * line of defence against injection).
   *
   * → `maxLength` stops the length, `pattern` stops the shape.
   * → An invalid regular expression → an error (not a crash at runtime).
   */
  pattern?: string;
  description?: string;
}

/** One role = one connection profile (it may only reference, never override a field — ADR-D31 R7) */
export interface WorkflowRole {
  purpose: string;
  /** The id of a connection profile that exists in the host */
  profile: string;
}

export const STEP_KINDS = [
  'exec',
  'file.transfer',
  'action',
  'await',
  'assert',
  'discover',
] as const;
export type WorkflowStepKind = (typeof STEP_KINDS)[number];

/** The five readback forms (exactly as in M6) plus `role` (on which role it is read) */
export interface WorkflowReadback {
  /** Form 1: `tag` (without a kind, as in `spec/02` section 4.4) */
  tag?: string;
  /** The kind of the forms 2–5 */
  kind?: 'file_equals' | 'command_ok' | 'verify' | 'none';
  /** The expected value of form 1 */
  expect?: string;
  /** The path of form 2 */
  path?: string;
  /** The tolerance of form 2 */
  tolerance?: number;
  /** The second verification command of form 4 */
  command?: string;
  /** The timeout of form 4 */
  timeout_ms?: number;
  /** The consequence of form 5 (required and non-empty) */
  consequence?: string;
  /** On which role it is read (not written = the role of this step itself) */
  role?: string;
}

export interface WorkflowEndpoint {
  role: string;
  path?: string;
  /** The semantic placement (a closed vocabulary); one of it with `path` */
  placement?: string;
}

export interface WorkflowStep {
  id: string;
  kind: WorkflowStepKind;
  /** The executing role (required for `exec` / `discover` / `action`) */
  role?: string;
  /** The command of `exec` */
  cmd?: string;
  /** The timeout of `exec` / `file.transfer` (milliseconds) */
  timeout_ms?: number;
  /** The id of the action that `action` refers to */
  action?: string;
  /** The parameters of `action` (the values may hold placeholders) */
  params?: Record<string, string>;
  /** The source of `file.transfer` */
  from?: WorkflowEndpoint;
  /** The destination of `file.transfer` */
  to?: WorkflowEndpoint;
  /** The directory `discover` searches in (the current directory by default) */
  dir?: string;
  /** The discovery rule of `discover` (no hard-coded file name) */
  pattern?: string;
  /** The exclude list of `discover` */
  exclude?: string[];
  /** The name of the output slot of `discover` */
  out?: string;
  /** The criterion of `await` / `assert` */
  readback?: WorkflowReadback;
  /** What happens when `assert` does not match: `fail` (default) | `continue` */
  on_mismatch?: 'fail' | 'continue';
  /**
   * The danger level of this step (default `reversible`).
   *
   * → A step that is `destructive` has to be confirmed by a human every
   *   time (the trust model of ADR-D31 R2).
   * → The step that prepares the credentials has to be `destructive`: it
   *   writes the `~/.ssh/authorized_keys` of the target machine (ADR-D31 R7
   *   / A10 of plan 6).
   * → A hit on the danger floor is treated as `destructive` as well (the
   *   stricter one wins).
   */
  danger?: 'reversible' | 'destructive';
}

export interface WorkflowPack {
  /**
   * The contract version (the same vocabulary as the board pack and the
   * card manifest — ADR-D34-1).
   *
   * → Once a workflow pack is promoted to the contract, it is the
   *   contract format → the version field has to be like everywhere else.
   *   (C1 of review 38: the contract writes `apiVersion` while the
   *   implementation was still at `formatVersion` — a pack that fully
   *   matches the contract was rejected by the implementation.)
   */
  apiVersion: 'devboard/v1';
  kind: 'Workflow';
  id: string;
  name: string;
  version: string;
  description?: string;
  inputs: Record<string, WorkflowInputDef>;
  roles: Record<string, WorkflowRole>;
  steps: WorkflowStep[];
}

/* ── The closed field tables for the validation ────────────────────────────────── */

/** The known contract versions (the same one as the board pack and the card manifest) */
export const KNOWN_API_VERSION = 'devboard/v1';

const TOP_KEYS = [
  'apiVersion',
  'kind',
  'id',
  'name',
  'version',
  'description',
  'inputs',
  'roles',
  'steps',
] as const;

/**
 * The closed field table of the inputs.
 *
 * → `default` and `pattern` (added 2026-11-15 — I1 of review 38):
 * the contract `spec/05` section 2 says "the type table follows `spec/02`
 * section 4.3", and `02` section 4.3 clearly has these two fields → the
 * implementation had left them out.
 * → `default`: the host prefills the common inputs (a card can be run
 *   with one click);
 * → `pattern`: the second line of defence against injection
 *   (`maxLength` stops the length, `pattern` stops the shape).
 */
const INPUT_KEYS = [
  'type',
  'required',
  'maxLength',
  'min',
  'max',
  'values',
  'default',
  'pattern',
  'description',
] as const;
const ROLE_KEYS = ['purpose', 'profile'] as const;

const STEP_KEYS = [
  'id',
  'kind',
  'role',
  'cmd',
  'timeout_ms',
  'action',
  'params',
  'from',
  'to',
  'dir',
  'pattern',
  'exclude',
  'out',
  'readback',
  'on_mismatch',
  'danger',
] as const;

const ENDPOINT_KEYS = ['role', 'path', 'placement'] as const;

const READBACK_KEYS = [
  'tag',
  'kind',
  'expect',
  'path',
  'tolerance',
  'command',
  'timeout_ms',
  'consequence',
  'role',
] as const;

/**
 * The facts that `{role:x.fact}` can read (closed — it may not reach into
 * an arbitrary field of the profile).
 *
 * → There is no `key` (added 2026-11-15):
 * the path of a credential should not be spliced into a command →
 * ① it would go into the audit line (one more piece of sensitive
 *   information in the chain of responsibility ✗);
 * ② it would go into the echo of `dry_run` (an unauthorised party sees
 *   the credential path ✗);
 * ③ and it is mostly useless: the command runs on the source
 *   target, and the source target uses its own ~/.ssh key, so the key
 *   path of the target target means nothing to the source target ✗.
 * → The credential is the host's business (in line with ADR-D31 R7 "only
 *   the profile id may be referenced").
 */
export const ROLE_FACTS = ['host', 'port', 'user', 'profile_id'] as const;

/* ── Small helpers ────────────────────────────────────────────────────────────── */

function fail(message: string, source: string, detail?: unknown): never {
  throw makeError('IPC_INVALID_PAYLOAD', message, {
    detail: { source, ...(detail === undefined ? {} : { detail }) },
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkKeys(ctx: Ctx, obj: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      fail(`Unknown field '${key}'`, ctx.source, { path: `${ctx.path}${path}${path ? '.' : ''}${key}` });
    }
  }
}

interface Ctx {
  source: string;
  path: string;
}

/**
 * Contract `05` section 9, rule 4: the format of the `id` is
 * "name.name".
 *
 * → Two segments · each segment is lowercase letters and digits ·
 *   a segment may contain hyphens (`hello-kernel.build-run` ·
 *   `prepare-credentials.authorize-key`).
 * → Why it is enforced: the `id` is the permission key
 *   (`workflow:<id>`) · the file name key · an identifier the agent
 *   can see → it has to be a token that cannot be injected → so no
 *   uppercase, no underscore, no space and no extra dot.
 */
const WORKFLOW_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;

function workflowId(value: unknown, ctx: Ctx): string {
  const id = nonEmptyString(value, 'id', ctx);
  if (!WORKFLOW_ID_PATTERN.test(id)) {
    fail(
      `id must be "name.name" (two segments · lowercase letters and digits · a segment may contain hyphens — for example hello-kernel.build-run) ✓ — got "${id}"`,
      ctx.source,
      { path: ctx.path },
    );
  }
  return id;
}

function nonEmptyString(value: unknown, what: string, ctx: Ctx): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${what} must be a non-empty string`, ctx.source, { path: ctx.path });
  }
  return value;
}

/* ── The placeholders ─────────────────────────────────────────────────────────── */

/**
 * `{input:x}` / `{role:x.fact}` / `{output:x}` / `{from.path}` / `{to.path}`
 *
 * → The last two are built in: they point at the source and the
 *   destination of this step itself. The destination one matters most
 *   — the path that `placement` resolves to is known only to the host
 *   (the kernel version has to be asked of the target machine) → the user
 *   must not write the path by hand.
 */
const PLACEHOLDER = /\{(input|role|output|from|to):([^}]+)\}/g;

export interface PlaceholderUse {
  kind: 'input' | 'role' | 'output' | 'from' | 'to';
  name: string;
  /** The name of the fact of a `role` placeholder (`host` / `port` / …) */
  fact?: string;
  /** The attribute of an `output` placeholder: `name` = the file name without the extension (`hello.ko` → `hello`) */
  attr?: 'name';
}

/** Dig out the placeholders that a text uses */
export function placeholdersOf(text: string): PlaceholderUse[] {
  const out: PlaceholderUse[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const kind = match[1] as PlaceholderUse['kind'];
    const body = match[2] ?? '';
    if (kind === 'role') {
      const [name, fact] = body.split('.');
      out.push({ kind, name: name ?? '', ...(fact === undefined ? {} : { fact }) });
      continue;
    }
    if (kind === 'output') {
      // `{output:slot}` or `{output:slot.name}` (the file name without the extension)
      const [slot, attr] = body.split('.');
      if (attr !== undefined && attr !== 'name') {
        out.push({ kind, name: body });
        continue;
      }
      out.push({ kind, name: slot ?? '', ...(attr === undefined ? {} : { attr: 'name' as const }) });
      continue;
    }
    out.push({ kind, name: body });
  }
  return out;
}

/* ── The parsing ─────────────────────────────────────────────────────────────── */

/**
 * Parse and validate a workflow pack.
 *
 * @param raw    the object that the YAML produced
 * @param source where it came from (the file path), written into the error
 *   messages so that the position can be found
 * @throws an unknown field / a missing required field / a wrong type / a
 *   placeholder that points at something that does not exist — it always
 *   throws, it never ignores silently
 */
export function parseWorkflow(raw: unknown, source: string): WorkflowPack {
  const ctx: Ctx = { source, path: '' };
  if (!isRecord(raw)) fail('The workflow pack must be an object', source);
  checkKeys(ctx, raw, TOP_KEYS, '');

  if (raw['apiVersion'] !== KNOWN_API_VERSION) {
    fail(`apiVersion must be ${KNOWN_API_VERSION} (the same version vocabulary as board packs and card manifests ✓)`, source);
  }
  if (raw['kind'] !== 'Workflow') {
    fail(`kind must be Workflow (got ${String(raw['kind'])})`, source);
  }

  const pack: WorkflowPack = {
    apiVersion: KNOWN_API_VERSION,
    kind: 'Workflow',
    id: workflowId(raw['id'], ctx),
    name: nonEmptyString(raw['name'], 'name', ctx),
    version: nonEmptyString(raw['version'], 'version', ctx),
    ...(raw['description'] === undefined
      ? {}
      : { description: nonEmptyString(raw['description'], 'description', ctx) }),
    inputs: parseInputs(raw['inputs'], ctx),
    roles: parseRoles(raw['roles'], ctx),
    steps: [],
  };

  pack.steps = parseSteps(raw['steps'], pack, ctx);
  checkPlaceholders(pack, ctx);
  return pack;
}

function parseInputs(raw: unknown, ctx: Ctx): Record<string, WorkflowInputDef> {
  if (!isRecord(raw)) fail('inputs must be an object', ctx.source);
  const out: Record<string, WorkflowInputDef> = {};
  for (const [name, value] of Object.entries(raw)) {
    const sub: Ctx = { source: ctx.source, path: `inputs.${name}` };
    if (!isRecord(value)) fail(`inputs.${name} must be an object`, ctx.source);
    checkKeys(sub, value, INPUT_KEYS, '');
    const type = value['type'];
    if (typeof type !== 'string' || !INPUT_TYPES.includes(type as WorkflowInputType)) {
      fail(`inputs.${name}.type must be one of ${INPUT_TYPES.join(' / ')}`, ctx.source);
    }
    const def: WorkflowInputDef = { type: type as WorkflowInputType };
    if (value['required'] !== undefined) {
      if (typeof value['required'] !== 'boolean') fail(`inputs.${name}.required must be a boolean`, ctx.source);
      def.required = value['required'];
    }
    if (value['maxLength'] !== undefined) {
      if (typeof value['maxLength'] !== 'number') fail(`inputs.${name}.maxLength must be a number`, ctx.source);
      def.maxLength = value['maxLength'];
    }
    if (value['min'] !== undefined) {
      if (typeof value['min'] !== 'number') fail(`inputs.${name}.min must be a number`, ctx.source);
      def.min = value['min'];
    }
    if (value['max'] !== undefined) {
      if (typeof value['max'] !== 'number') fail(`inputs.${name}.max must be a number`, ctx.source);
      def.max = value['max'];
    }
    if (value['values'] !== undefined) {
      if (!Array.isArray(value['values']) || value['values'].some((v) => typeof v !== 'string')) {
        fail(`inputs.${name}.values must be an array of strings`, ctx.source);
      }
      def.values = value['values'] as string[];
    }
    if (value['default'] !== undefined) {
      def.default = value['default'];
    }
    if (value['pattern'] !== undefined) {
      const pattern = nonEmptyString(value['pattern'], `inputs.${name}.pattern`, ctx);
      // The regular expression itself has to be valid (an invalid one → an error now, not a crash at runtime ✗)
      try {
        new RegExp(pattern);
      } catch (err) {
        fail(
          `inputs.${name}.pattern is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`,
          ctx.source,
        );
      }
      def.pattern = pattern;
    }
    if (value['description'] !== undefined) {
      def.description = nonEmptyString(value['description'], `inputs.${name}.description`, ctx);
    }
    // enum must have values; string / path must have maxLength (otherwise it is an open mouth)
    if (def.type === 'enum' && (def.values === undefined || def.values.length === 0)) {
      fail(`inputs.${name} is enum → it must declare values (a closed value set)`, ctx.source);
    }
    if ((def.type === 'string' || def.type === 'path') && def.maxLength === undefined) {
      fail(`inputs.${name} is ${def.type} → it must declare maxLength (no unbounded strings)`, ctx.source);
    }
    // The default has to be valid itself (it is used as a real value)
    if (def.default !== undefined) checkDefault(def, name, ctx);
    out[name] = def;
  }
  return out;
}

/**
 * The default value has to be valid itself.
 *
 * → An input with `default: 999` and `max: 255` → the host prefills an
 *   illegal value ✗
 * → it is only noticed at runtime ✗ → it is an error right now.
 */
function checkDefault(def: WorkflowInputDef, name: string, ctx: Ctx): void {
  const value = def.default;
  switch (def.type) {
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail(`inputs.${name}.default must be a number (type: ${def.type})`, ctx.source);
      }
      if (def.min !== undefined && value < def.min) {
        fail(`inputs.${name}.default is below min (${def.min})`, ctx.source);
      }
      if (def.max !== undefined && value > def.max) {
        fail(`inputs.${name}.default is above max (${def.max})`, ctx.source);
      }
      return;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        fail(`inputs.${name}.default must be a boolean`, ctx.source);
      }
      return;
    }
    case 'enum': {
      if (typeof value !== 'string' || !(def.values ?? []).includes(value)) {
        fail(`inputs.${name}.default must be one of the values`, ctx.source);
      }
      return;
    }
    case 'string':
    case 'path': {
      if (typeof value !== 'string') {
        fail(`inputs.${name}.default must be a string`, ctx.source);
      }
      if (def.maxLength !== undefined && value.length > def.maxLength) {
        fail(`inputs.${name}.default exceeds maxLength (${def.maxLength})`, ctx.source);
      }
      if (def.pattern !== undefined && !new RegExp(def.pattern).test(value)) {
        fail(`inputs.${name}.default does not match pattern`, ctx.source);
      }
      return;
    }
  }
}

function parseRoles(raw: unknown, ctx: Ctx): Record<string, WorkflowRole> {
  if (!isRecord(raw)) fail('roles must be an object', ctx.source);
  const out: Record<string, WorkflowRole> = {};
  for (const [name, value] of Object.entries(raw)) {
    const sub: Ctx = { source: ctx.source, path: `roles.${name}` };
    if (!isRecord(value)) fail(`roles.${name} must be an object`, ctx.source);
    checkKeys(sub, value, ROLE_KEYS, '');
    out[name] = {
      purpose: nonEmptyString(value['purpose'], `roles.${name}.purpose`, ctx),
      profile: nonEmptyString(value['profile'], `roles.${name}.profile`, ctx),
    };
  }
  if (Object.keys(out).length === 0) fail('roles must not be empty (a workflow always needs a target)', ctx.source);
  return out;
}

function parseSteps(raw: unknown, pack: WorkflowPack, ctx: Ctx): WorkflowStep[] {
  if (!Array.isArray(raw) || raw.length === 0) fail('steps must be a non-empty array', ctx.source);
  const out: WorkflowStep[] = [];
  const seen = new Set<string>();
  for (const [i, value] of raw.entries()) {
    const sub: Ctx = { source: ctx.source, path: `steps[${i}]` };
    if (!isRecord(value)) fail(`steps[${i}] must be an object`, ctx.source);
    checkKeys(sub, value, STEP_KEYS, '');
    const step = parseStep(value, pack, sub);
    if (seen.has(step.id)) fail(`steps[${i}].id '${step.id}' is a duplicate`, ctx.source);
    seen.add(step.id);
    out.push(step);
  }
  return out;
}

function parseStep(raw: Record<string, unknown>, pack: WorkflowPack, ctx: Ctx): WorkflowStep {
  const id = nonEmptyString(raw['id'], 'step.id', ctx);
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !STEP_KINDS.includes(kind as WorkflowStepKind)) {
    fail(`step.kind must be one of ${STEP_KINDS.join(' / ')}`, ctx.source);
  }
  const step: WorkflowStep = { id, kind: kind as WorkflowStepKind };

  if (raw['role'] !== undefined) {
    step.role = nonEmptyString(raw['role'], 'step.role', ctx);
    if (!Object.hasOwn(pack.roles, step.role)) {
      fail(`step.role '${step.role}' was never declared`, ctx.source, { path: ctx.path });
    }
  }
  if (raw['cmd'] !== undefined) step.cmd = nonEmptyString(raw['cmd'], 'step.cmd', ctx);
  if (raw['timeout_ms'] !== undefined) {
    if (typeof raw['timeout_ms'] !== 'number') fail('step.timeout_ms must be a number', ctx.source);
    step.timeout_ms = raw['timeout_ms'];
  }
  if (raw['action'] !== undefined) step.action = nonEmptyString(raw['action'], 'step.action', ctx);
  if (raw['params'] !== undefined) {
    if (!isRecord(raw['params'])) fail('step.params must be an object', ctx.source);
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw['params'])) {
      params[k] = nonEmptyString(v, `step.params.${k}`, ctx);
    }
    step.params = params;
  }
  if (raw['from'] !== undefined) step.from = parseEndpoint(raw['from'], pack, ctx, 'from');
  if (raw['to'] !== undefined) step.to = parseEndpoint(raw['to'], pack, ctx, 'to');
  if (raw['dir'] !== undefined) step.dir = nonEmptyString(raw['dir'], 'step.dir', ctx);
  if (raw['pattern'] !== undefined) step.pattern = nonEmptyString(raw['pattern'], 'step.pattern', ctx);
  if (raw['exclude'] !== undefined) {
    if (!Array.isArray(raw['exclude']) || raw['exclude'].some((v) => typeof v !== 'string')) {
      fail('step.exclude must be an array of strings', ctx.source);
    }
    step.exclude = raw['exclude'] as string[];
  }
  if (raw['out'] !== undefined) step.out = nonEmptyString(raw['out'], 'step.out', ctx);
  if (raw['readback'] !== undefined) step.readback = parseReadback(raw['readback'], pack, ctx);
  if (raw['danger'] !== undefined) {
    const danger = raw['danger'];
    if (danger !== 'reversible' && danger !== 'destructive') {
      fail("step.danger must be 'reversible' or 'destructive'", ctx.source);
    }
    step.danger = danger;
  }
  if (raw['on_mismatch'] !== undefined) {
    const value = raw['on_mismatch'];
    if (value !== 'fail' && value !== 'continue') {
      fail("step.on_mismatch must be 'fail' or 'continue'", ctx.source);
    }
    step.on_mismatch = value;
  }

  // ── Rule 11 (contract section 9): a step with `danger: destructive` may not use `readback.kind: none`
  // → The same as `02` section 4.4.1 (the rule 15 of the board pack is it — it is there, and here it has always been missing ✗)
  // → The consequence of not blocking it: an irreversible step may declare "no verification" ✗ → it runs anyway ✓ (nobody is asked any more ✓)
  //   → the timeline reports `ok:true / verified:false` ✓ → the interface calls "not verified at all" a success ✗
  if (step.danger === 'destructive' && step.readback?.kind === 'none') {
    fail('a destructive step must not use readback.kind: none (an irreversible action cannot go unverified ✓ — same as 02 §4.4.1 ✓)', ctx.source);
  }

  // ── The required fields of each kind ──
  switch (step.kind) {
    case 'exec':
      if (step.role === undefined) fail('an exec step must declare role', ctx.source);
      if (step.cmd === undefined) fail('an exec step must declare cmd', ctx.source);
      break;
    case 'discover':
      if (step.role === undefined) fail('a discover step must declare role', ctx.source);
      if (step.pattern === undefined) fail('a discover step must declare pattern (the artefact must not hardcode a file name)', ctx.source);
      if (step.out === undefined) fail('a discover step must declare out (which slot the discovery result goes into)', ctx.source);
      break;
    case 'file.transfer':
      if (step.from === undefined) fail('a file.transfer step must declare from', ctx.source);
      // from.path is required (contract section 4.4) —
      // → it is not caught here ✓ → it only crashes at runtime ✓ (and it crashes outside the step ✓ → the timeline does not even get a line ✗)
      if (step.from.path === undefined) {
        fail('the from of a file.transfer step must declare path (the path on the source side)', ctx.source);
      }
      if (step.to === undefined) fail('a file.transfer step must declare to', ctx.source);
      if (step.cmd === undefined) {
        fail('a file.transfer step must declare cmd (the transfer command template; it runs on the **source** target)', ctx.source);
      }
      break;
    case 'action':
      if (step.role === undefined) fail('an action step must declare role', ctx.source);
      if (step.action === undefined) fail('an action step must declare action (the action id)', ctx.source);
      break;
    case 'await':
    case 'assert':
      if (step.readback === undefined) fail(`an ${step.kind} step must declare readback`, ctx.source);
      // It has to be possible to say "on which role it is read" (its own role or the role of the criterion ✓)
      // — otherwise "which one is read by default" would be a guess ✗ (two independent reviews both pointed at this ✓).
      if (step.role === undefined && step.readback.role === undefined) {
        fail(`an ${step.kind} step must say which role to read on (step.role or readback.role)`, ctx.source);
      }
      break;
  }

  return step;
}

function parseEndpoint(
  raw: unknown,
  pack: WorkflowPack,
  ctx: Ctx,
  what: 'from' | 'to',
): WorkflowEndpoint {
  if (!isRecord(raw)) fail(`step.${what} must be an object`, ctx.source);
  checkKeys(ctx, raw, ENDPOINT_KEYS, '');
  const role = nonEmptyString(raw['role'], `step.${what}.role`, ctx);
  if (!Object.hasOwn(pack.roles, role)) {
    fail(`step.${what}.role '${role}' was never declared`, ctx.source, { path: ctx.path });
  }
  const endpoint: WorkflowEndpoint = { role };
  if (raw['path'] !== undefined) endpoint.path = nonEmptyString(raw['path'], `step.${what}.path`, ctx);
  if (raw['placement'] !== undefined) {
    const placement = nonEmptyString(raw['placement'], `step.${what}.placement`, ctx);
    if (!isPlacement(placement)) {
      fail(
        `step.${what}.placement '${placement}' is not in the closed vocabulary (${PLACEMENT_IDS.join(' / ')})`,
        ctx.source,
      );
    }
    endpoint.placement = placement;
  }
  if (what === 'to' && endpoint.path === undefined && endpoint.placement === undefined) {
    fail('step.to must declare path or placement (three forms of destination: path / placement / ask)', ctx.source);
  }
  return endpoint;
}

function parseReadback(raw: unknown, pack: WorkflowPack, ctx: Ctx): WorkflowReadback {
  if (!isRecord(raw)) fail('step.readback must be an object', ctx.source);
  checkKeys(ctx, raw, READBACK_KEYS, '');
  const out: WorkflowReadback = {};

  // Form 1: `readback: {tag, expect}` (without a kind — as in spec/02 section 4.4)
  if (raw['tag'] !== undefined) {
    // Form 1 (tag) is not supported at the workflow layer for now:
    // a tag is something of the core vocabulary of the board pack (`spec/02` section 6 ✓),
    // and the workflow layer has no board pack → it cannot look up whether it is a real tag ✗
    // → Instead of "accepting it and quietly dropping the role", it is an error right away (two independent reviews both pointed at this ✓).
    fail('workflow criteria do not support form 1 (tag) yet: a tag belongs to the core vocabulary of the board pack, which the workflow layer cannot look up', ctx.source);
  }

  const kind = raw['kind'];
  if (
    kind !== 'file_equals' &&
    kind !== 'command_ok' &&
    kind !== 'verify' &&
    kind !== 'none'
  ) {
    fail('readback.kind must be one of file_equals / command_ok / verify / none (form 1 uses tag)', ctx.source);
  }
  out.kind = kind;
  if (raw['expect'] !== undefined) out.expect = nonEmptyString(raw['expect'], 'readback.expect', ctx);
  if (raw['path'] !== undefined) out.path = nonEmptyString(raw['path'], 'readback.path', ctx);
  if (raw['tolerance'] !== undefined) {
    if (typeof raw['tolerance'] !== 'number') fail('readback.tolerance must be a number', ctx.source);
    out.tolerance = raw['tolerance'];
  }
  if (raw['command'] !== undefined) out.command = nonEmptyString(raw['command'], 'readback.command', ctx);
  if (raw['timeout_ms'] !== undefined) {
    if (typeof raw['timeout_ms'] !== 'number') fail('readback.timeout_ms must be a number', ctx.source);
    out.timeout_ms = raw['timeout_ms'];
  }
  if (raw['consequence'] !== undefined) {
    out.consequence = nonEmptyString(raw['consequence'], 'readback.consequence', ctx);
  }
  if (raw['role'] !== undefined) {
    const role = nonEmptyString(raw['role'], 'readback.role', ctx);
    if (!Object.hasOwn(pack.roles, role)) {
      fail(`readback.role '${role}' was never declared`, ctx.source, { path: ctx.path });
    }
    out.role = role;
  }

  // The required fields of each form (as in spec/02 section 4.4)
  if (kind === 'file_equals' && (out.path === undefined || out.expect === undefined)) {
    fail('readback form 2 (file_equals) must declare path and expect', ctx.source);
  }
  if (kind === 'verify' && out.command === undefined) {
    fail('readback form 4 (verify) must declare command', ctx.source);
  }
  if (kind === 'none' && (out.consequence === undefined || out.consequence.length === 0)) {
    fail('readback form 5 (none) must declare a non-empty consequence', ctx.source);
  }
  return out;
}

/* ── The static check of the placeholders ─────────────────────────────────────── */

/**
 * The placeholders have to point at something that was declared:
 * - `{input:x}` → x has to be a declared input;
 * - `{role:r.fact}` → r has to be a declared role and the fact has to be in
 *   the closed table of the facts;
 * - `{output:s}` → s has to be a slot that an earlier step produced.
 *
 * Why it is checked here: a typo that only explodes at runtime means
 * the workflow fails halfway through.
 */
function checkPlaceholders(pack: WorkflowPack, ctx: Ctx): void {
  /** The slots that the earlier steps produced */

  const produced = new Set<string>();
  for (const [i, step] of pack.steps.entries()) {
    const texts: string[] = [];
    if (step.cmd !== undefined) texts.push(step.cmd);
    if (step.from?.path !== undefined) texts.push(step.from.path);
    if (step.to?.path !== undefined) texts.push(step.to.path);
    if (step.params !== undefined) texts.push(...Object.values(step.params));
    if (step.readback?.path !== undefined) texts.push(step.readback.path);
    if (step.readback?.expect !== undefined) texts.push(step.readback.expect);
    if (step.readback?.command !== undefined) texts.push(step.readback.command);

    for (const text of texts) {
      for (const use of placeholdersOf(text)) {
        if (use.kind === 'input') {
          if (!Object.hasOwn(pack.inputs, use.name)) {
            fail(`{input:${use.name}} in steps[${i}] points at an input that was never declared`, ctx.source);
          }
          continue;
        }
        if (use.kind === 'role') {
          if (!Object.hasOwn(pack.roles, use.name)) {
            fail(`{role:${use.name}...} in steps[${i}] points at a role that was never declared`, ctx.source);
          }
          if (use.fact === undefined || !(ROLE_FACTS as readonly string[]).includes(use.fact)) {
            fail(
              `the fact name in {role:${use.name}.${use.fact ?? ''}} in steps[${i}] is not in the closed table (${ROLE_FACTS.join(' / ')})`,
              ctx.source,
            );
          }
          continue;
        }
        if (use.kind === 'from' || use.kind === 'to') {
          if (step.kind !== 'file.transfer') {
            fail(`{${use.kind}:${use.name}} in steps[${i}] is only available in a file.transfer step`, ctx.source);
          }
          continue;
        }
        if (!produced.has(use.name)) {
          fail(`{output:${use.name}} in steps[${i}] points at a slot that was never produced`, ctx.source);
        }
      }
    }
    if (step.out !== undefined) produced.add(step.out);
  }
}

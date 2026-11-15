import { makeError } from '../../shared/errors';
import { PLACEMENT_IDS, isPlacement } from './placement';

/**
 * 流程包（workflow pack）的格式与校验器 —— **宿主层格式**。
 *
 * > ⚠️ **它不是契约**：`docs/spec/` 五份**一个字不改**（ADR-D31 R1）。
 * > 流程包首版是**宿主层的数据格式**（`docs/29` + `fixtures/`），
 * > 真板跑通**两条**流程之后才谈晋升契约。
 *
 * ── 它回答什么 ──
 *
 * | 包 | 回答 |
 * |---|---|
 * | 板型包（board pack） | **这块板有什么**（能产生哪些量、能接受哪些写） |
 * | 流程包（workflow pack） | **这件事怎么做**（多目标、多步骤、有判据） |
 *
 * ── 三条设计底线 ──
 *
 * 1. **封闭 schema**：未知字段**一律报错**。流程包是**声明**——
 *    拼错的字段被静默忽略 = 流程照跑，只是少做了一件事，或做在了别的目标上。
 * 2. **step kind 只有 6 个**（ADR-D31 R11）：`exec` / `file.transfer` / `action` /
 *    `await` / `assert` / `discover`。`exec_script` **连「留位置」都不留**。
 * 3. **判据复用 M6 的回读五形式**（ADR-D31 R3）——**不新增第六种形式**，
 *    只是**多了一个「在哪个 role 上读」**（跨目标的验证就靠它）。
 */

/** 输入的封闭类型表（照 `spec/02` §4.3，**不另造一套**） */
export const INPUT_TYPES = ['string', 'integer', 'number', 'boolean', 'enum', 'path'] as const;
export type WorkflowInputType = (typeof INPUT_TYPES)[number];

export interface WorkflowInputDef {
  type: WorkflowInputType;
  required?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  /** `enum` 才有：允许的取值（封闭） */
  values?: string[];
  description?: string;
}

/** 一个角色 = 一个连接 profile（**只许引用，不许覆写字段**——ADR-D31 R7） */
export interface WorkflowRole {
  purpose: string;
  /** 宿主里存在的连接 profile id */
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

/** 回读的五形式（与 M6 完全一致）+ `role`（在哪个角色上读） */
export interface WorkflowReadback {
  /** 形式 1：`tag`（**不带 kind**，与 `spec/02` §4.4 一样） */
  tag?: string;
  /** 形式 2–5 的 kind */
  kind?: 'file_equals' | 'command_ok' | 'verify' | 'none';
  /** 形式 1 的期望值 */
  expect?: string;
  /** 形式 2 的路径 */
  path?: string;
  /** 形式 2 的容差 */
  tolerance?: number;
  /** 形式 4 的二次验证命令 */
  command?: string;
  /** 形式 4 的超时 */
  timeout_ms?: number;
  /** 形式 5 的后果说明（必填非空） */
  consequence?: string;
  /** **在哪个角色上读**（不写 = 本步自己的角色） */
  role?: string;
}

export interface WorkflowEndpoint {
  role: string;
  path?: string;
  /** 语义落位（**封闭词表**）；与 `path` 二选一 */
  placement?: string;
}

export interface WorkflowStep {
  id: string;
  kind: WorkflowStepKind;
  /** 执行角色（`exec` / `discover` / `action` 必填） */
  role?: string;
  /** `exec` 的命令 */
  cmd?: string;
  /** `exec` / `file.transfer` 的超时（毫秒） */
  timeout_ms?: number;
  /** `action` 引用的动作 id */
  action?: string;
  /** `action` 的参数（值里可以有占位符） */
  params?: Record<string, string>;
  /** `file.transfer` 的源 */
  from?: WorkflowEndpoint;
  /** `file.transfer` 的目的地 */
  to?: WorkflowEndpoint;
  /** `discover` 在哪个目录找（默认当前目录） */
  dir?: string;
  /** `discover` 的发现规则（**不写死文件名**） */
  pattern?: string;
  /** `discover` 的排除表 */
  exclude?: string[];
  /** `discover` 的输出槽名 */
  out?: string;
  /** `await` / `assert` 的判据 */
  readback?: WorkflowReadback;
  /** `assert` 不符时怎么办：`fail`（默认）| `continue` */
  on_mismatch?: 'fail' | 'continue';
  /**
   * 这一步的**危险等级**（默认 `reversible`）。
   *
   * → `destructive` 的步骤**每次都要人确认**（ADR-D31 R2 的信任模型 ✓）。
   * → **凭据准备那一步必须是 `destructive`**：它写的是目标机器的
   *   `~/.ssh/authorized_keys`（ADR-D31 R7 / 计划 6 的 A10 ✓）。
   * → **危险地板命中 → 也按 `destructive` 处理**（取更严的 ✓）。
   */
  danger?: 'reversible' | 'destructive';
}

export interface WorkflowPack {
  /** 宿主层格式版本（**不是契约的 `apiVersion`**——免得混淆） */
  formatVersion: 1;
  kind: 'Workflow';
  id: string;
  name: string;
  version: string;
  description?: string;
  inputs: Record<string, WorkflowInputDef>;
  roles: Record<string, WorkflowRole>;
  steps: WorkflowStep[];
}

/* ── 校验用的封闭字段表 ────────────────────────────────────────────── */

const TOP_KEYS = [
  'formatVersion',
  'kind',
  'id',
  'name',
  'version',
  'description',
  'inputs',
  'roles',
  'steps',
] as const;

const INPUT_KEYS = ['type', 'required', 'maxLength', 'min', 'max', 'values', 'description'] as const;
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

/** `{role:x.fact}` 能取的事实（**封闭**——不许翻 profile 的任意字段） */
export const ROLE_FACTS = ['host', 'port', 'user', 'key', 'profile_id'] as const;

/* ── 小工具 ────────────────────────────────────────────────────────── */

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
      fail(`未知字段 '${key}'`, ctx.source, { path: `${ctx.path}${path}${path ? '.' : ''}${key}` });
    }
  }
}

interface Ctx {
  source: string;
  path: string;
}

function nonEmptyString(value: unknown, what: string, ctx: Ctx): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${what} 必须是非空字符串`, ctx.source, { path: ctx.path });
  }
  return value;
}

/* ── 占位符 ────────────────────────────────────────────────────────── */

/**
 * `{input:x}` / `{role:x.fact}` / `{output:x}` / `{from.path}` / `{to.path}`
 *
 * → **最后两个是内置的**：它们指**这一步自己的**源与目的地。
 * 目的地那个尤其要紧——`placement` 解析出来的路径**宿主才知道**
 * （内核版本要问目标机器）→ 不许用户手写路径 ✓。
 */
const PLACEHOLDER = /\{(input|role|output|from|to):([^}]+)\}/g;

export interface PlaceholderUse {
  kind: 'input' | 'role' | 'output' | 'from' | 'to';
  name: string;
  /** `role` 占位符的事实名（`host` / `port` / …） */
  fact?: string;
  /** `output` 占位符的属性：`name` = 文件名去掉扩展名（`hello.ko` → `hello`） */
  attr?: 'name';
}

/** 把一段文本里用到的占位符挖出来 */
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
      // `{output:slot}` 或 `{output:slot.name}`（文件名去掉扩展名）
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

/* ── 解析 ──────────────────────────────────────────────────────────── */

/**
 * 解析并校验一份流程包。
 *
 * @param raw    YAML 解析出来的对象
 * @param source 出处（文件路径），写进错误信息里便于定位
 * @throws 未知字段 / 缺必填 / 类型不对 / 占位符指向不存在的东西 —— **都抛错，不静默忽略**
 */
export function parseWorkflow(raw: unknown, source: string): WorkflowPack {
  const ctx: Ctx = { source, path: '' };
  if (!isRecord(raw)) fail('流程包必须是一个对象', source);
  checkKeys(ctx, raw, TOP_KEYS, '');

  if (raw['formatVersion'] !== 1) {
    fail('formatVersion 必须是 1（宿主层格式版本；它不是契约的 apiVersion）', source);
  }
  if (raw['kind'] !== 'Workflow') {
    fail(`kind 必须是 Workflow（收到的是 ${String(raw['kind'])}）`, source);
  }

  const pack: WorkflowPack = {
    formatVersion: 1,
    kind: 'Workflow',
    id: nonEmptyString(raw['id'], 'id', ctx),
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
  if (!isRecord(raw)) fail('inputs 必须是一个对象', ctx.source);
  const out: Record<string, WorkflowInputDef> = {};
  for (const [name, value] of Object.entries(raw)) {
    const sub: Ctx = { source: ctx.source, path: `inputs.${name}` };
    if (!isRecord(value)) fail(`inputs.${name} 必须是一个对象`, ctx.source);
    checkKeys(sub, value, INPUT_KEYS, '');
    const type = value['type'];
    if (typeof type !== 'string' || !INPUT_TYPES.includes(type as WorkflowInputType)) {
      fail(`inputs.${name}.type 必须是 ${INPUT_TYPES.join(' / ')} 之一`, ctx.source);
    }
    const def: WorkflowInputDef = { type: type as WorkflowInputType };
    if (value['required'] !== undefined) {
      if (typeof value['required'] !== 'boolean') fail(`inputs.${name}.required 必须是布尔`, ctx.source);
      def.required = value['required'];
    }
    if (value['maxLength'] !== undefined) {
      if (typeof value['maxLength'] !== 'number') fail(`inputs.${name}.maxLength 必须是数字`, ctx.source);
      def.maxLength = value['maxLength'];
    }
    if (value['min'] !== undefined) {
      if (typeof value['min'] !== 'number') fail(`inputs.${name}.min 必须是数字`, ctx.source);
      def.min = value['min'];
    }
    if (value['max'] !== undefined) {
      if (typeof value['max'] !== 'number') fail(`inputs.${name}.max 必须是数字`, ctx.source);
      def.max = value['max'];
    }
    if (value['values'] !== undefined) {
      if (!Array.isArray(value['values']) || value['values'].some((v) => typeof v !== 'string')) {
        fail(`inputs.${name}.values 必须是字符串数组`, ctx.source);
      }
      def.values = value['values'] as string[];
    }
    if (value['description'] !== undefined) {
      def.description = nonEmptyString(value['description'], `inputs.${name}.description`, ctx);
    }
    // enum 必须有 values；string / path 必须有 maxLength（不然是开口的）
    if (def.type === 'enum' && (def.values === undefined || def.values.length === 0)) {
      fail(`inputs.${name} 是 enum → 必须给 values（封闭取值表）`, ctx.source);
    }
    if ((def.type === 'string' || def.type === 'path') && def.maxLength === undefined) {
      fail(`inputs.${name} 是 ${def.type} → 必须给 maxLength（不许开口）`, ctx.source);
    }
    out[name] = def;
  }
  return out;
}

function parseRoles(raw: unknown, ctx: Ctx): Record<string, WorkflowRole> {
  if (!isRecord(raw)) fail('roles 必须是一个对象', ctx.source);
  const out: Record<string, WorkflowRole> = {};
  for (const [name, value] of Object.entries(raw)) {
    const sub: Ctx = { source: ctx.source, path: `roles.${name}` };
    if (!isRecord(value)) fail(`roles.${name} 必须是一个对象`, ctx.source);
    checkKeys(sub, value, ROLE_KEYS, '');
    out[name] = {
      purpose: nonEmptyString(value['purpose'], `roles.${name}.purpose`, ctx),
      profile: nonEmptyString(value['profile'], `roles.${name}.profile`, ctx),
    };
  }
  if (Object.keys(out).length === 0) fail('roles 不能是空的（流程总要有个目标）', ctx.source);
  return out;
}

function parseSteps(raw: unknown, pack: WorkflowPack, ctx: Ctx): WorkflowStep[] {
  if (!Array.isArray(raw) || raw.length === 0) fail('steps 必须是非空数组', ctx.source);
  const out: WorkflowStep[] = [];
  const seen = new Set<string>();
  for (const [i, value] of raw.entries()) {
    const sub: Ctx = { source: ctx.source, path: `steps[${i}]` };
    if (!isRecord(value)) fail(`steps[${i}] 必须是一个对象`, ctx.source);
    checkKeys(sub, value, STEP_KEYS, '');
    const step = parseStep(value, pack, sub);
    if (seen.has(step.id)) fail(`steps[${i}].id '${step.id}' 重复了`, ctx.source);
    seen.add(step.id);
    out.push(step);
  }
  return out;
}

function parseStep(raw: Record<string, unknown>, pack: WorkflowPack, ctx: Ctx): WorkflowStep {
  const id = nonEmptyString(raw['id'], 'step.id', ctx);
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !STEP_KINDS.includes(kind as WorkflowStepKind)) {
    fail(`step.kind 必须是 ${STEP_KINDS.join(' / ')} 之一`, ctx.source);
  }
  const step: WorkflowStep = { id, kind: kind as WorkflowStepKind };

  if (raw['role'] !== undefined) {
    step.role = nonEmptyString(raw['role'], 'step.role', ctx);
    if (!Object.hasOwn(pack.roles, step.role)) {
      fail(`step.role '${step.role}' 没人声明过`, ctx.source, { path: ctx.path });
    }
  }
  if (raw['cmd'] !== undefined) step.cmd = nonEmptyString(raw['cmd'], 'step.cmd', ctx);
  if (raw['timeout_ms'] !== undefined) {
    if (typeof raw['timeout_ms'] !== 'number') fail('step.timeout_ms 必须是数字', ctx.source);
    step.timeout_ms = raw['timeout_ms'];
  }
  if (raw['action'] !== undefined) step.action = nonEmptyString(raw['action'], 'step.action', ctx);
  if (raw['params'] !== undefined) {
    if (!isRecord(raw['params'])) fail('step.params 必须是一个对象', ctx.source);
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
      fail('step.exclude 必须是字符串数组', ctx.source);
    }
    step.exclude = raw['exclude'] as string[];
  }
  if (raw['out'] !== undefined) step.out = nonEmptyString(raw['out'], 'step.out', ctx);
  if (raw['readback'] !== undefined) step.readback = parseReadback(raw['readback'], pack, ctx);
  if (raw['danger'] !== undefined) {
    const danger = raw['danger'];
    if (danger !== 'reversible' && danger !== 'destructive') {
      fail("step.danger 必须是 'reversible' 或 'destructive'", ctx.source);
    }
    step.danger = danger;
  }
  if (raw['on_mismatch'] !== undefined) {
    const value = raw['on_mismatch'];
    if (value !== 'fail' && value !== 'continue') {
      fail("step.on_mismatch 必须是 'fail' 或 'continue'", ctx.source);
    }
    step.on_mismatch = value;
  }

  // ── 每种 kind 的必填 ──
  switch (step.kind) {
    case 'exec':
      if (step.role === undefined) fail('exec 步必须有 role', ctx.source);
      if (step.cmd === undefined) fail('exec 步必须有 cmd', ctx.source);
      break;
    case 'discover':
      if (step.role === undefined) fail('discover 步必须有 role', ctx.source);
      if (step.pattern === undefined) fail('discover 步必须有 pattern（产物不写死文件名）', ctx.source);
      if (step.out === undefined) fail('discover 步必须有 out（发现结果进哪个槽）', ctx.source);
      break;
    case 'file.transfer':
      if (step.from === undefined) fail('file.transfer 步必须有 from', ctx.source);
      if (step.to === undefined) fail('file.transfer 步必须有 to', ctx.source);
      if (step.cmd === undefined) {
        fail('file.transfer 步必须有 cmd（传输命令模板；它在**源**目标上跑）', ctx.source);
      }
      break;
    case 'action':
      if (step.role === undefined) fail('action 步必须有 role', ctx.source);
      if (step.action === undefined) fail('action 步必须有 action（动作 id）', ctx.source);
      break;
    case 'await':
    case 'assert':
      if (step.readback === undefined) fail(`${step.kind} 步必须有 readback`, ctx.source);
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
  if (!isRecord(raw)) fail(`step.${what} 必须是一个对象`, ctx.source);
  checkKeys(ctx, raw, ENDPOINT_KEYS, '');
  const role = nonEmptyString(raw['role'], `step.${what}.role`, ctx);
  if (!Object.hasOwn(pack.roles, role)) {
    fail(`step.${what}.role '${role}' 没人声明过`, ctx.source, { path: ctx.path });
  }
  const endpoint: WorkflowEndpoint = { role };
  if (raw['path'] !== undefined) endpoint.path = nonEmptyString(raw['path'], `step.${what}.path`, ctx);
  if (raw['placement'] !== undefined) {
    const placement = nonEmptyString(raw['placement'], `step.${what}.placement`, ctx);
    if (!isPlacement(placement)) {
      fail(
        `step.${what}.placement '${placement}' 不在封闭词表里（${PLACEMENT_IDS.join(' / ')}）`,
        ctx.source,
      );
    }
    endpoint.placement = placement;
  }
  if (what === 'to' && endpoint.path === undefined && endpoint.placement === undefined) {
    fail('step.to 必须有 path 或 placement（目的地三形态：path / placement / ask）', ctx.source);
  }
  return endpoint;
}

function parseReadback(raw: unknown, pack: WorkflowPack, ctx: Ctx): WorkflowReadback {
  if (!isRecord(raw)) fail('step.readback 必须是一个对象', ctx.source);
  checkKeys(ctx, raw, READBACK_KEYS, '');
  const out: WorkflowReadback = {};

  // 形式 1：`readback: {tag, expect}`（**不带 kind**——与 spec/02 §4.4 一样）
  if (raw['tag'] !== undefined) {
    out.tag = nonEmptyString(raw['tag'], 'readback.tag', ctx);
    if (raw['expect'] !== undefined) {
      // 形式 1 的期望值**可以是布尔**（契约里就是 `expect: true`）
      const expect = raw['expect'];
      if (typeof expect !== 'boolean' && typeof expect !== 'string') {
        fail('readback.expect 必须是布尔或字符串（形式 1 用布尔）', ctx.source);
      }
      out.expect = String(expect);
    }
    return out;
  }

  const kind = raw['kind'];
  if (
    kind !== 'file_equals' &&
    kind !== 'command_ok' &&
    kind !== 'verify' &&
    kind !== 'none'
  ) {
    fail('readback.kind 必须是 file_equals / command_ok / verify / none 之一（形式 1 用 tag）', ctx.source);
  }
  out.kind = kind;
  if (raw['expect'] !== undefined) out.expect = nonEmptyString(raw['expect'], 'readback.expect', ctx);
  if (raw['path'] !== undefined) out.path = nonEmptyString(raw['path'], 'readback.path', ctx);
  if (raw['tolerance'] !== undefined) {
    if (typeof raw['tolerance'] !== 'number') fail('readback.tolerance 必须是数字', ctx.source);
    out.tolerance = raw['tolerance'];
  }
  if (raw['command'] !== undefined) out.command = nonEmptyString(raw['command'], 'readback.command', ctx);
  if (raw['timeout_ms'] !== undefined) {
    if (typeof raw['timeout_ms'] !== 'number') fail('readback.timeout_ms 必须是数字', ctx.source);
    out.timeout_ms = raw['timeout_ms'];
  }
  if (raw['consequence'] !== undefined) {
    out.consequence = nonEmptyString(raw['consequence'], 'readback.consequence', ctx);
  }
  if (raw['role'] !== undefined) {
    const role = nonEmptyString(raw['role'], 'readback.role', ctx);
    if (!Object.hasOwn(pack.roles, role)) {
      fail(`readback.role '${role}' 没人声明过`, ctx.source, { path: ctx.path });
    }
    out.role = role;
  }

  // 各形式的必填（与 spec/02 §4.4 一致）
  if (kind === 'file_equals' && (out.path === undefined || out.expect === undefined)) {
    fail('readback 形式 2（file_equals）必须有 path 与 expect', ctx.source);
  }
  if (kind === 'verify' && out.command === undefined) {
    fail('readback 形式 4（verify）必须有 command', ctx.source);
  }
  if (kind === 'none' && (out.consequence === undefined || out.consequence.length === 0)) {
    fail('readback 形式 5（none）必须有非空的 consequence', ctx.source);
  }
  return out;
}

/* ── 占位符的静态检查 ──────────────────────────────────────────────── */

/**
 * 占位符必须在**声明过的东西**上：
 * - `{input:x}` → x 必须是声明过的 input；
 * - `{role:r.fact}` → r 必须是声明过的 role，fact 必须在封闭事实表里；
 * - `{output:s}` → s 必须是**前面某一步**产出的槽。
 *
 * **为什么现在查**：拼错到运行时才炸 = 流程跑到一半才失败。
 */
function checkPlaceholders(pack: WorkflowPack, ctx: Ctx): void {
  /** 已经被前面的步骤产出的槽 */
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
            fail(`steps[${i}] 里的 {input:${use.name}} 指向没声明过的 input`, ctx.source);
          }
          continue;
        }
        if (use.kind === 'role') {
          if (!Object.hasOwn(pack.roles, use.name)) {
            fail(`steps[${i}] 里的 {role:${use.name}...} 指向没声明过的 role`, ctx.source);
          }
          if (use.fact === undefined || !(ROLE_FACTS as readonly string[]).includes(use.fact)) {
            fail(
              `steps[${i}] 里的 {role:${use.name}.${use.fact ?? ''}} 的事实名不在封闭表里（${ROLE_FACTS.join(' / ')}）`,
              ctx.source,
            );
          }
          continue;
        }
        if (use.kind === 'from' || use.kind === 'to') {
          if (step.kind !== 'file.transfer') {
            fail(`steps[${i}] 里的 {${use.kind}:${use.name}} 只有 file.transfer 步才有`, ctx.source);
          }
          continue;
        }
        if (!produced.has(use.name)) {
          fail(`steps[${i}] 里的 {output:${use.name}} 指向没产出过的槽`, ctx.source);
        }
      }
    }
    if (step.out !== undefined) produced.add(step.out);
  }
}

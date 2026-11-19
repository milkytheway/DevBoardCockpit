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
  /**
   * 默认值（**调用方没给时用它** ✓ —— `spec/02` §4.3 ✓）。
   *
   * → 宿主**预填**常用输入 ✓（卡片点一下就能跑 ✓）。
   * → **必须过该类型的取值检查** ✓（它自己也要合法 ✓）。
   */
  default?: unknown;
  /**
   * `string` 时的形状约束（**正则** ✓ —— 注入防线的第二道 ✓）。
   *
   * → `maxLength` 挡长度 ✓、`pattern` 挡形状 ✓。
   * → **正则本身非法 → 报错** ✓（不是等到运行时才炸 ✗）。
   */
  pattern?: string;
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
  /**
   * 契约版本（**与板型包、卡片 manifest 同一套词汇** ✓ —— ADR-D34-1 ✓）。
   *
   * → 流程包晋升契约后，**它就是契约格式** ✓ → 版本字段必须与别处一样 ✓。
   *   （评审 38 的 C1 ✓：契约写 `apiVersion`，实现却还停在 `formatVersion` ——
   *   **一份完全符合契约的包会被实现拒掉** ✗。）
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

/* ── 校验用的封闭字段表 ────────────────────────────────────────────── */

/** 已知的契约版本（**与板型包、卡片 manifest 同一个** ✓） */
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
 * 输入的封闭字段表。
 *
 * → **`default` 与 `pattern`**（2026-11-15 加 ✓ —— 评审 38 的 I1 ✓）：
 * 契约 `spec/05` §二 说「类型表照 `spec/02` §4.3」✓，
 * 而 `02` §4.3 明确有这两个字段 ✓ → **是实现漏了** ✓。
 * → `default`：宿主**预填**常用输入 ✓（卡片点一下就能跑 ✓）；
 * → `pattern`：**注入防线的第二道** ✓（`maxLength` 挡长度、`pattern` 挡形状 ✓）。
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
 * `{role:x.fact}` 能取的事实（**封闭**——不许翻 profile 的任意字段）。
 *
 * → **没有 `key`**（2026-11-15 加 ✓）：
 * 凭据的**路径**不该被插进命令 ✓ ——
 * ① 它会进审计行（**追责链里多一份敏感信息** ✗）；
 * ② 它会进 `dry_run` 的回显（**未授权方能看到凭据路径** ✗）；
 * ③ 而且它**多半没用**：命令跑在**源目标**上，源目标用的是**它自己的** ~/.ssh 密钥 ✓，
 * 目标目标的密钥路径对源目标没有意义 ✗。
 * → **凭据是宿主的账**（与 ADR-D31 R7「只许引用 profile id」一致 ✓）。
 */
export const ROLE_FACTS = ['host', 'port', 'user', 'profile_id'] as const;

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
      fail(`Unknown field '${key}'`, ctx.source, { path: `${ctx.path}${path}${path ? '.' : ''}${key}` });
    }
  }
}

interface Ctx {
  source: string;
  path: string;
}

/**
 * **契约 `05` §九 规则 4** ✓：`id` 的格式是「名字.名字」✓。
 *
 * → **两段** ✓ · **每段是小写字母与数字** ✓ · **段内可以用连字符** ✓
 *   （`hello-kernel.build-run` ✓ · `prepare-credentials.authorize-key` ✓）。
 * → **为什么卡它** ✓：`id` 是**权限键**（`workflow:<id>` ✓）· **文件名键** ✓ ·
 *   **agent 看得见的标识** ✓ → **它得是一个不可注入的记号** ✓。
 *   → **所以大写、下划线、空格、多一个点都不行** ✓。
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
      // **正则自己得合法** ✓（非法正则 → 现在报错，不是运行时才炸 ✗）
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
    // enum 必须有 values；string / path 必须有 maxLength（不然是开口的）
    if (def.type === 'enum' && (def.values === undefined || def.values.length === 0)) {
      fail(`inputs.${name} is enum → it must declare values (a closed value set)`, ctx.source);
    }
    if ((def.type === 'string' || def.type === 'path') && def.maxLength === undefined) {
      fail(`inputs.${name} is ${def.type} → it must declare maxLength (no unbounded strings)`, ctx.source);
    }
    // **default 自己也要合法** ✓（它会被当成真的值用 ✓）
    if (def.default !== undefined) checkDefault(def, name, ctx);
    out[name] = def;
  }
  return out;
}

/**
 * 默认值**自己也要合法** ✓。
 *
 * → 一个 `default: 999` 配 `max: 255` 的 input → **宿主预填一个非法值** ✗
 * → 到运行时才发现 ✗ → 现在就报错 ✓。
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

  // ── **规则 11**（契约 §九 ✓）：`danger: destructive` 的步不许用 `readback.kind: none` ✓
  // → 与 `02` §4.4.1 同款 ✓（板型包的规则 15 就是它 ✓ —— 那边有 ✓，这边**一直缺着** ✗）
  // → 不拦的后果 ✓：不可逆的步可以声明「不验证」✗ → **照样执行** ✓（**今天不再问人** ✓）
  //   → 时间线报 `ok:true / verified:false` ✓ → 界面把「根本没验证」说成「成功了」✗
  if (step.danger === 'destructive' && step.readback?.kind === 'none') {
    fail('a destructive step must not use readback.kind: none (an irreversible action cannot go unverified ✓ — same as 02 §4.4.1 ✓)', ctx.source);
  }

  // ── 每种 kind 的必填 ──
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
      // **from.path 是必填** ✓（契约 §4.4 ✓）——
      // → 不在这里收住 ✓ → 运行时才炸 ✓（而且炸在**步外** ✓ → 时间线上一行都没有 ✗）
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
      // **必须说得出「在哪个角色上读」**（自己的 role 或判据的 role ✓）
      // ——不然「默认读哪」就是猜的 ✗（两条独立评审都点了这一条 ✓）。
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

  // 形式 1：`readback: {tag, expect}`（**不带 kind**——与 spec/02 §4.4 一样）
  if (raw['tag'] !== undefined) {
    // **形式 1（tag）在流程层暂不支持**：
    // tag 是**板型包的核心词表**里的东西（`spec/02` §六 ✓），
    // 而流程层**没有板型包** → 查不了它是不是真 tag ✗
    // → 与其「收下再悄悄丢掉 role」，**直接报错** ✓（两条独立评审都点了这一条 ✓）。
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

  // 各形式的必填（与 spec/02 §4.4 一致）
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

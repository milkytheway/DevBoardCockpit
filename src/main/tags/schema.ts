/**
 * 板型包的数据结构（**纯类型**，没有逻辑）。
 *
 * 契约：`docs/spec/02-board-pack.md` §一（一个包长什么样）、§四（动作）。
 *
 * **这些类型只描述「包里能写什么」，不判断「写得对不对」**——
 * 对不对是校验器的事（`validator.ts`，27 条规则）。
 * 加载器（`pack.ts`）只做**结构**核对：字段在不在、类型对不对、位置对不对。
 *
 * **为什么分三个文件**：
 * - `schema.ts` —— 形状（这里）
 * - `pack.ts` —— 读进来 + 结构核对
 * - `validator.ts` —— 语义核对（27 条规则）
 *
 * 混在一起的后果很具体：**「参数名拼错了」这种错误会被报成「包坏了」**，
 * 而它其实是「kind 的参数名写错了」——两者的修法完全不同。
 */

/** 动作参数的声明（契约 §4.3） */
export interface PackParam {
  type: 'integer' | 'number' | 'string' | 'boolean' | 'enum';
  min?: number;
  max?: number;
  default?: unknown;
  /** `type: enum` 时的取值列表，**非空**（规则 20） */
  values?: string[];
  /** `type: string` 时**必填**（规则 20）——没有上限的字符串参数就是注入面 */
  maxLength?: number;
  pattern?: string;
}

/** 参数域（契约 §5.5）。只能**缩小** params 的声明域，不能扩大（规则 22） */
export interface PackGuard {
  min?: number;
  max?: number;
}

/** `provides` 的一条绑定：sample → tag（契约 §1.1） */
export interface ProvidesDef {
  tag: string;
  sample: string;
}

/** 一个 reader（契约 §二） */
export interface ReaderDef {
  id: string;
  /** kind 名（契约 §2.4 的封闭清单） */
  kind: string;
  /** kind 的参数。**内容不受加载器管**——参数名对不对问 kind 的 schema（规则 8） */
  args?: Record<string, unknown>;
  provides: ProvidesDef[];
}

/** 一个轮询分组（契约 §1.2）：一个组 = 一次往返 */
export interface PollGroupDef {
  id: string;
  interval_ms: number;
  /** 这个组里的 reader id（规则 17：每个 reader 恰好属于一个组） */
  readers: string[];
}

/**
 * 回读块（契约 §4.4 的五种形式）。
 *
 * **形状是「平的」**——这里不按 `kind` 分叉：
 * 「`kind` 属于哪几种」「`none` 必须带 `consequence`」「`destructive` 不许用 `none`」
 * 都是**规则 15 / 23 / 27** 的事，归校验器管。
 * 加载器只报「这里写了什么」，不替契约做判断。
 */
export interface ReadbackDef {
  /** 不写就是形式 1（读一个 tag） */
  kind?: string;
  tag?: string;
  expect?: unknown;
  path?: string;
  tolerance?: number;
  command?: string;
  timeout_ms?: number;
  /** `kind: none` 时必填且非空（规则 27） */
  consequence?: string;
}

/** 一个动作（契约 §四） */
export interface ActionDef {
  id: string;
  label?: string;
  danger: 'reversible' | 'destructive';
  params?: Record<string, PackParam>;
  guard?: Record<string, PackGuard>;
  command: string;
  /** **每个动作都必须有**（规则 27）——`reversible` 也不例外 */
  readback?: ReadbackDef;
}

/** 板型包 */
export interface BoardPack {
  apiVersion: string;
  kind: 'BoardPack';
  id: string;
  name: string;
  version: string;
  description?: string;
  requires: {
    transports: string[];
    /** 板级能力（封闭词表，契约 §10.3.1） */
    capabilities: string[];
    min_contract?: string;
  };
  /** 危险地板表的版本（契约 §5.2.1）。当前只有 1 */
  danger_floor_version?: number;
  /** 自动识别用的型号规则（契约 §十）。`mode` 的取值域由规则 11 查 */
  match?: { mode: string; models: string[] };
  poll_groups: PollGroupDef[];
  /** 板子通用能力（契约 §九） */
  readers: ReaderDef[];
  /** 板型私有能力（契约 §九）。没有就空着 */
  custom: ReaderDef[];
  actions: ActionDef[];
}

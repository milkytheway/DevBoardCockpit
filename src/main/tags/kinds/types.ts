import type { ParseResult } from './parse-util';

/**
 * reader kind 的形状。
 *
 * 契约：`docs/spec/02-board-pack.md` §2.4（内置 reader kind 清单，v1）。
 *
 * **每个 kind 声明三件事**：接受什么参数、产出什么 sample、怎么从板子上取。
 * 清单封闭 = AI 的心智模型封闭 = AI 写卡时不会猜。
 */

/** 参数的声明 */
export interface ParamSpec {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'enum' | 'glob' | 'map';
  /** 必填（规则 9） */
  required?: boolean;
  /** `type: enum` 时的取值列表 */
  values?: string[];
  default?: unknown;
  /**
   * 这组参数里**至少要给一个**。
   *
   * `file_read` 的 `path`/`glob` 是这一类（契约 §2.4 写的是 `path`/`glob`）——
   * 不是「一个必填、一个可选」，而是「二选一」。
   */
  oneOf?: string[];
}

/**
 * 解析时的上下文。
 *
 * **解析是纯函数**（N1）：同样的输入给同样的输出。
 * 唯一允许的状态是「两次采样之间的历史」（`proc_stat` 的上一次计数器），
 * 且**状态由 runtime 传进来**——不许藏在模块级变量里，
 * 否则两个连接会互相污染对方的历史。
 */
export interface ReaderContext {
  state: Record<string, unknown>;
}

/** 一个 reader kind */
export interface ReaderKind {
  id: string;
  /** 参数 schema：名字 → 声明。规则 8/9 查它 */
  params: Record<string, ParamSpec>;
  /**
   * 这个 kind 能产出的 **sample 模式**。
   *
   * 规则 6 拿包里的 `provides[].sample` 与它比对——
   * 所以这里存的是**模式**（`zone.*`），不是具体名字。
   */
  samples: string[];
  /**
   * sample 名段数不限（契约 §3.3 末段：只有 `script`）。
   *
   * `script` 的 sample 来自脚本输出的 JSON 键，
   * 所以它的 sample **不能**写成固定清单。
   */
  unboundedSamples?: boolean;
  /**
   * 需要两次采样（契约 §2.4：只有 `proc_stat`）。
   *
   * 首读的结果是 `pending`——**不是 0**（规则 5）。
   */
  needsTwoSamples?: boolean;
  /**
   * 这个 kind 的取数片段要用**运行时提供的远端路径**（`args['remote_path']`）。
   *
   * `script` 是唯一一个：脚本住在宿主上，要先推到板子的 `/tmp` 里才跑得起来
   * （契约 §3.3）。运行时**还没提供**远端路径时，
   * 不该生成一条注定失败的命令——**如实报「没推上去」**。
   */
  needsRemotePath?: boolean;
  /**
   * 取数：从板子上把数据取回来的 shell 片段。
   *
   * **必须是一行**——串口一次往返只能是一行命令（事实 S6）。
   */
  fetch(args: Record<string, unknown>): string;
  /**
   * 解析：把板子返回的文本变成 sample。
   *
   * **纯函数**（N1）：同样的输入给同样的输出。
   * **读不到不是 0**（N2）：解析不出来 → `unavailable`，
   * 绝不填 0、绝不返回 NaN。
   */
  parse(raw: string, args: Record<string, unknown>, ctx: ReaderContext): ParseResult;
}

export type { ParseResult };

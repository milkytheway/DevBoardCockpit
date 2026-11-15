import type { BoardPack, PollGroupDef, ReaderDef } from './schema';

/**
 * **板型包的脱敏只读投影**（契约 `spec/04` §2.1 / §2.4 ✓ · ADR-D40 ✓）。
 *
 * ── 它解决什么 ──
 *
 * `TagRuntime.pack` 是**私有的** ✓ —— 而 MCP 的读侧工具要看到它 ✓
 * （`list_data_sources` ✓ / `describe_tag` ✓ / `list_tags` ✓）。
 *
 * → **但不能把原始 args 直接给 agent** ✓：
 * `exec_regex` 的 args 里有 **`command`** ✓（一条要跑在板子上的裸命令 ✓），
 * `script` 的 args 里有 **`path`（宿主文件系统上的路径）**与 **`interpreter`** ✓
 * → 那两个拼起来就是「宿主上有什么、在哪」+「一条命令」✗
 * → **正是契约 §1.3「不准有裸 send_command」要防的那件事** ✓。
 *
 * ── 放行表按 `(kind, 参数名)` 判定 ──
 *
 * **不是**按参数名单独判定 ✓ —— 因为 `path` 在 `file_read` 里是**板上路径**（可给 ✓），
 * 在 `script` 里是**宿主路径**（不可给 ✓）。
 *
 * → **逐 kind 写死** ✓（契约 v5 §2.4 的那张 ✓）
 * → **不在表里的参数一律不给** ✓（封闭表 ✓，不是「先给再筛」✓）。
 */

/** reader 的脱敏视图 */
export interface ReaderView {
  /** reader 的 id */
  id: string;
  /** reader 的 kind（`proc_stat` / `file_read` / …） */
  kind: string;
  /**
   * **脱敏后**的参数 ✓ —— **只含放行表里的那些** ✓。
   *
   * → **值是字符串或纯 JSON** ✓ —— `type_map` 是对象 ✓（那是**纯数据** ✓ · 不敏感 ✓）
   *   → **保留原形** ✓（agent 读得懂 ✓）；数组与其它对象 **JSON 化** ✓。
   */
  args: Record<string, string | Record<string, string>>;
  /** 它提供的 tag 模式（**不是**具体名 ✓ —— 具体名由读数决定 ✓） */
  provides: string[];
  /** 它属于哪个轮询组（`null` = 没有组 —— 那种包过不了校验 ✓） */
  poll_group: string | null;
  /** 它所在轮询组的周期（`null` = 没有组 ✓） */
  interval_ms: number | null;
}

/** 板型包的脱敏视图 */
export interface PackView {
  id: string;
  name: string;
  version: string;
  /** 轮询组（**组 = 一次往返** ✓） */
  poll_groups: PollGroupDef[];
  /** 全部 reader（`readers` + `custom` ✓） */
  readers: ReaderView[];
  /** 动作 id 清单（**只给 id** ✓ —— 参数与命令属于「动作定义」✓） */
  actions: string[];
}

/**
 * **放行表** —— 按 `(kind, 参数名)` 判定 ✓。
 *
 * → **封闭表** ✓ —— **不在表里的参数一律不给** ✓。
 * → **加一个 kind 或改一张表 = 契约变更** ✓（契约 v5 §2.4 ✓）。
 */
const ALLOWED_ARGS: Readonly<Record<string, readonly string[]>> = {
  proc_stat: ['stat_path', 'cpuinfo_path'],
  meminfo: ['path'],
  devfreq_load: ['path', 'measure'],
  rknpu_load: ['path'],
  thermal_zone: ['glob', 'type_map'],
  file_read: ['path', 'glob', 'format', 'strip_trailing_null'],
  exec_regex: ['pattern', 'format'],
  // **`script` 恒为空** ✓ —— 它的 `path` 是宿主路径 ✓ · `interpreter` 与它是一套 ✓
  script: [],
};

/**
 * **一个参数值怎么变成人能读懂的形态** ✓。
 *
 * → **`type_map` 那种「字符串 → 字符串」的映射保留原形** ✓（纯数据 ✓ · 不敏感 ✓ · agent 读得懂 ✓）
 * → **其它对象与数组 JSON 化** ✓
 * → **标量转字符串** ✓
 */
function argValue(value: unknown): string | Record<string, string> {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (isStringMap(value)) {
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) out[key] = String(item);
    return out;
  }
  return JSON.stringify(value);
}

/** 这是不是「字符串 → 字符串」的映射（`type_map` 那种 ✓） */
function isStringMap(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === 'string');
}

/** 一个 reader 的脱敏 args（**只含放行表里的** ✓） */
function sanitizeArgs(reader: ReaderDef): Record<string, string | Record<string, string>> {
  const allowed = ALLOWED_ARGS[reader.kind];
  // **表里没有这个 kind → 一个参数都不给** ✓（不猜 ✓）
  if (allowed === undefined) return {};
  const out: Record<string, string | Record<string, string>> = {};
  for (const name of allowed) {
    const value = reader.args?.[name];
    if (value === undefined) continue;
    out[name] = argValue(value);
  }
  return out;
}

/** reader 属于哪个组（**规则 17**：每个 reader 恰好属于一个组 ✓） */
function groupOf(pack: BoardPack, readerId: string): PollGroupDef | undefined {
  return pack.poll_groups.find((g) => g.readers.includes(readerId));
}

/**
 * **把板型包投影成脱敏视图** ✓。
 *
 * @param pack 当前绑定的板型包（**没有就是 `null`** ✓ —— 不猜 ✓）
 * @returns 脱敏视图；**没有包就是 `null`** ✓
 */
export function packView(pack: BoardPack | undefined): PackView | null {
  if (pack === undefined) return null;

  const all: ReaderDef[] = [...pack.readers, ...pack.custom];
  const readers: ReaderView[] = all.map((reader) => {
    const group = groupOf(pack, reader.id);
    return {
      id: reader.id,
      kind: reader.kind,
      args: sanitizeArgs(reader),
      provides: reader.provides.map((p) => p.tag),
      poll_group: group?.id ?? null,
      interval_ms: group?.interval_ms ?? null,
    };
  });

  return {
    id: pack.id,
    name: pack.name,
    version: pack.version,
    poll_groups: pack.poll_groups.map((g) => ({
      id: g.id,
      interval_ms: g.interval_ms,
      readers: [...g.readers],
    })),
    readers,
    actions: pack.actions.map((a) => a.id),
  };
}

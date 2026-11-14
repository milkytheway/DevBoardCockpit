import type { FileEntry } from '../../shared/ipc-contract';

/**
 * 产物发现 —— **按规则找，不写死文件名**。
 *
 * ── 为什么不能写死 ──
 *
 * `hello.ko` 写进流程包 → 换个项目名就得改包 ✗；
 * 而「编译出来的是什么」**本来就是编译器的事**，流程包不该替它决定 ✓。
 * → 包里只说「**找 `*.ko`**」，找到哪个就是哪个 ✓。
 *
 * ── 规则 ──
 *
 * | 字段 | 意思 |
 * |---|---|
 * | `pattern` | **要什么**（按**文件名**匹配：`*.ko` / `meminfo`） |
 * | `exclude` | **不要什么**（同样的匹配方式；`*.o` / `*.mod.c`） |
 *
 * → 排除表**必须**有：编译目录里满是中间产物（`.o` / `.cmd` / `.order`），
 * 漏一个就可能把中间文件当产物送上去 ✗。
 */

/** 文件名匹配（只支持 `*` 通配 —— **够用且没有歧义**） */
export function matchesPattern(name: string, pattern: string): boolean {
  if (pattern === name) return true;
  if (!pattern.includes('*')) return false;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(name);
}

/** 发现的入口（**列远端目录**——HAL 有这个能力 ✓） */
export interface DiscoverDeps {
  /** 列一个远端目录 */
  list: (dir: string) => Promise<FileEntry[]>;
}

/**
 * 在一个目录里按规则找产物。
 *
 * @returns 找到的路径（按名字排序 —— **结果要可复现** ✓）
 */
export async function discoverArtifacts(
  deps: DiscoverDeps,
  opts: { dir: string; pattern: string; exclude?: string[] },
): Promise<string[]> {
  const entries = await deps.list(opts.dir);
  const excluded = opts.exclude ?? [];
  const found = entries
    .filter((entry) => !entry.isDirectory)
    .filter((entry) => matchesPattern(entry.name, opts.pattern))
    .filter((entry) => !excluded.some((rule) => matchesPattern(entry.name, rule)))
    .map((entry) => entry.path)
    .sort();
  return found;
}

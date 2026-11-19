import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadBoardPack } from './pack';
import type { BoardPack } from './schema';

/**
 * 板型包 ↔ 连接的绑定（契约 `docs/spec/02-board-pack.md` §十）。
 *
 * ── 契约要的两件事 ──
 *
 * | 契约 | 这里 |
 * |---|---|
 * | 「**采用「连接里指名 + 自动识别兜底」**」 | `boardPackId` 非空 → 用它；否则读型号自动识别 |
 * | 「认不出来怎么办：**不猜**。报『这块板没有板型包』」 | 零个或多个匹配 → `source: 'none'` + reason |
 *
 * ── 自动识别为什么是「读一次型号」而不是「跑 reader 看能不能读出来」──
 *
 * 契约 §十 写得很清楚：`board.model` 本身是某个板型包提供的 tag——
 * 「如果绑定发生在 reader 启动之前，就存在**先有鸡还是先有蛋**」。
 * 所以契约**不采用探测匹配**（跑 reader 看能不能读出来 → 无限递归），
 * 而是用**一次性探测**：读型号字符串，按 `match.models` 匹配。
 *
 * ── 「不猜」为什么这么要紧 ──
 *
 * 契约 §十：「这条很重要：板型包是增强，不是前提。」
 * 而猜错的后果是「把 `gpu.usage` 绑到一块没有 GPU 的板上——
 * **一个恒为 0 的仪表**」。
 *
 * **恒为 0 的仪表比没有仪表更危险**（事实 G2 的同一条道理）：
 * 它看起来是真的。
 */

/** 读型号需要的能力（只用到 exec） */
export interface ModelReader {
  exec(
    command: string,
    opts?: { timeoutMs?: number },
  ): Promise<{ exitCode: number | null; stdout: string; stderr?: string }>;
}

/** 契约 §十 的 match 规则 */
export function matchPack(pack: BoardPack, model: string): boolean {
  const match = pack.match;
  if (match === undefined) return false;
  if (match.models.length === 0) return false;

  const target = model.trim();
  if (target.length === 0) return false;

  if (match.mode === 'exact') {
    return match.models.some((m) => m === target);
  }
  if (match.mode === 'substring') {
    return match.models.some((m) => target.includes(m));
  }
  // 未知 mode → 不匹配（不猜）
  return false;
}

/** 绑定结果 */
export type PackBinding =
  | { pack: BoardPack; source: 'profile'; reason?: undefined }
  | { pack: BoardPack; source: 'auto'; reason?: undefined }
  | { pack: null; source: 'none'; reason: string };

export interface ResolvePackOptions {
  /** 连接（用来读型号） */
  connection: ModelReader;
  /** 连接 profile 里的 board_pack（可能为 null） */
  boardPackId: string | null;
  /** 板型包目录的父目录（**内置那一份** ✓） */
  packsDir: string;
  /**
   * **用户自己的板型包目录** ✓（**可选** ✓ —— 不存在就跳过 ✓）。
   *
   * → **为什么要有它** ✓（2026-11-19 加 ✓）：运行时**只读一个目录** ✓
   *   → **用户数据目录里的包没有任何人读** ✗ → **向导的产物落地即废** ✗。
   * → **同 id 时用户优先** ✓（与 `profiles/loader.ts` 同款 ✓）。
   */
  userPacksDir?: string;
  /** 读型号的方式。默认走连接的 exec 读 /proc/device-tree/model */
  readModel?: () => Promise<string>;
}

/**
 * **几个目录里所有的板型包**（按包 id 排序，顺序稳定 ✓）。
 *
 * ── 为什么是「几个目录」而不是「一个」✓（2026-11-19 加 ✓）──
 *
 * → **现状**：只有**内置那一个** ✓ —— `src/main/index.ts:210` ✓
 *   `packsDir: join(app.getAppPath(), 'profiles', 'boards')` ✓
 *   → **永远是 asar 里那个** ✓ → **用户数据目录里的板型包没有任何人读** ✗。
 * → **后果**：**向导实例化出来的包落地即废** ✗。
 * → 而且这**不只是向导的事** ✓ —— **现在**用户自己往用户数据目录放一份包 ✓
 *   **运行时也读不到** ✓ → **一个已经存在、没人提的洞** ✓。
 *
 * ── 规矩照谁（**三套合并逻辑，挑最干净的那套** ✓）──
 *
 * | 东西 | 合并方式 | 出处 |
 * |---|---|---|
 * | **连接 profile** | ✅ **先内置，后用户 —— 同 id 时用户覆盖内置** ✓ | `profiles/loader.ts` ✓ |
 * | **流程包** | ✅ **后扫的覆盖先扫的** ✓ | `workflows/registry.ts` ✓ |
 * | **卡片** | ✅ `roots: CardRoot[]` ✓ | `cards/wiring.ts` ✓ |
 * | **板型包** | ⚠️ **只有内置** ✗ → **本条补上** ✓ | —— |
 *
 * → **照 `profiles/loader.ts` 那套写** ✓ —— 一个 `Map` ✓ + 一个 `collect` ✓。
 *
 * ── **坏包不拖垮其余** ✓ ──
 *
 * → 一个写坏的包**只跳过一个** ✓（与 profile 加载器同款 ✓）
 * → **用户不该因为一个 typo 就整个应用起不来** ✓。
 */
export function listPacksIn(dirs: readonly string[]): BoardPack[] {
  const merged = new Map<string, BoardPack>();
  for (const packsDir of dirs) {
    if (!existsSync(packsDir)) continue;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(packsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isDirectory()) continue;
      const dir = join(packsDir, entry.name);
      if (!existsSync(join(dir, 'board.yaml'))) continue;
      try {
        const pack = loadBoardPack(dir);
        merged.set(pack.id, pack);
      } catch {
        // **坏包只跳过一个** ✓（与 profile 加载器同款 ✓）
      }
    }
  }
  // **后扫的覆盖先扫的** ✓ → **调用方把用户目录放在后面** ✓
  return [...merged.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** 读一次型号 */
async function readModelOf(opts: ResolvePackOptions): Promise<string> {
  if (opts.readModel !== undefined) return opts.readModel();
  const result = await opts.connection.exec('cat /proc/device-tree/model');
  // 设备树的模型字符串**末尾带 NUL**（实测），去掉它再比。
  return result.stdout.replace(/\0+$/, '').trim();
}

/**
 * 解析这条连接该用哪个板型包。
 *
 * **不猜**：零个或多个候选都返回 `source: 'none'`，并说清原因。
 */
export async function resolvePack(opts: ResolvePackOptions): Promise<PackBinding> {
  // **两个目录** ✓（内置 + 用户 ✓ · **用户在后** ✓ → 同 id 时用户优先 ✓）
  const packDirs = opts.userPacksDir === undefined ? [opts.packsDir] : [opts.packsDir, opts.userPacksDir];

  // 1) 连接里指名了 → 就用它（**不去读型号**）
  const namedId = opts.boardPackId;
  if (namedId !== null && namedId.length > 0) {
    // **两个目录都找** ✓ —— 否则用户目录里的包指名取不到 ✗
    for (const dir of packDirs) {
      const candidate = join(dir, namedId);
      if (!existsSync(join(candidate, 'board.yaml'))) continue;
      try {
        return { pack: loadBoardPack(candidate), source: 'profile' };
      } catch {
        // **坏包 → 说清楚** ✓（**不静默** ✓）
        return {
          pack: null,
          source: 'none',
          reason: `连接指名了板型包「${opts.boardPackId}」，但 ${candidate} 里的 board.yaml 读不出来`,
        };
      }
    }
    return {
      pack: null,
      source: 'none',
      reason:
        `连接指名了板型包「${opts.boardPackId}」，但 ` +
        `${packDirs.map((d) => join(d, namedId)).join(' 与 ')} 里都没有 board.yaml`,
    };
  }

  // 2) 自动识别兜底：读**一次**型号
  const model = await readModelOf(opts);

  // 3) 跟每个包的 match 比（**两个目录的包一起比** ✓）
  const hits = listPacksIn(packDirs).filter((p) => matchPack(p, model));

  if (hits.length === 1) {
    return { pack: hits[0], source: 'auto' };
  }
  if (hits.length === 0) {
    return {
      pack: null,
      source: 'none',
      reason: `这块板没有板型包（型号「${model}」没匹配上任何一个包）`,
    };
  }
  return {
    pack: null,
    source: 'none',
    reason:
      `有**多个**板型包都匹配型号「${model}」（${hits.map((p) => p.id).join(' / ')}）` +
      '——不猜，请让连接指明要哪一个',
  };
}

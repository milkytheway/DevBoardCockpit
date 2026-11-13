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
  /** 板型包目录的父目录 */
  packsDir: string;
  /** 读型号的方式。默认走连接的 exec 读 /proc/device-tree/model */
  readModel?: () => Promise<string>;
}

/** 目录里所有的板型包（按包 id 排序，顺序稳定） */
function listPacks(packsDir: string): BoardPack[] {
  if (!existsSync(packsDir)) return [];
  const out: BoardPack[] = [];
  for (const entry of readdirSync(packsDir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (!entry.isDirectory()) continue;
    const dir = join(packsDir, entry.name);
    if (!existsSync(join(dir, 'board.yaml'))) continue;
    out.push(loadBoardPack(dir));
  }
  return out;
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
  // 1) 连接里指名了 → 就用它（**不去读型号**）
  if (opts.boardPackId !== null && opts.boardPackId.length > 0) {
    const dir = join(opts.packsDir, opts.boardPackId);
    if (!existsSync(join(dir, 'board.yaml'))) {
      return {
        pack: null,
        source: 'none',
        reason: `连接指名了板型包「${opts.boardPackId}」，但 ${dir} 里没有 board.yaml`,
      };
    }
    return { pack: loadBoardPack(dir), source: 'profile' };
  }

  // 2) 自动识别兜底：读**一次**型号
  const model = await readModelOf(opts);

  // 3) 跟每个包的 match 比
  const hits = listPacks(opts.packsDir).filter((p) => matchPack(p, model));

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

import type { ConnectionInfo } from '../../shared/ipc-contract';

/**
 * **界面这一层只认板**（板实物与连接是两层 ✓ —— 契约 `spec/02` §10.2 ✓）。
 *
 * ── 为什么有这一层 ──
 *
 * → 一块板有 **ADB / 串口 / SSH** 三条连接 ✓ → **它们是同一块板** ✓
 * → 界面要让用户按**板**去想 ✓ —— 不是按**通道** ✓。
 * → 用户 2026-11-16 明确：「**仅支持板卡选择，不要把连接这些放进去**」✓
 *   → **菜单里只列板** ✓ → **哪条连接由宿主挑** ✓。
 *
 * ── 四条规矩（**都是「不猜」** ✓）──
 *
 * | # | 规矩 | 为什么 |
 * |---|---|---|
 * | 1 | **设备的名字就是 `device_key`** ✓ | **不编一个名字出来** ✗ —— 三条连接的 label 各不相同（`板子 · ADB` / `板子 · 串口` / `板子 · SSH` ✓）→ **取哪个都是编** ✗ → **用它的身份** ✓ |
 * | 2 | **没绑板型包的连接不是板** ✓ | **本机与客机不是板** ✓ —— 与运行时候选同一把尺 ✓（`tags/runtime.ts` ✓） |
 * | 3 | **当前那块排第一** ✓ | 选板的人**先看到自己在用哪块** ✓ |
 * | 4 | **一块板只有一个「当前」** ✓ | 两处都说「当前」= **数据乱了** ✓ → **只认第一条** ✓（**不猜第二个是谁** ✓） |
 */

/** 一块板（**界面看到的就是这么多** ✓ —— **连接不列** ✓） */
export interface Board {
  /** **这块板的标识** ✓（**它的名字也是这个** ✓ —— 不编 ✓） */
  deviceKey: string;
  /** **板型包**（**这块板的型号** ✓） */
  boardPack: string;
  /** **当前运行时用的就是这块板** ✓ */
  current: boolean;
  /** **这块板有几条连接** ✓（**只是信息** ✓ —— **界面不给用户选连接** ✓） */
  connectionCount: number;
}

/**
 * 把连接按板归并。
 *
 * → **只留绑了板型包的连接** ✓（**本机 / 客机不算板** ✓）
 * → **当前那块排第一** ✓，其余按输入顺序 ✓。
 * → **板的名字是 `device_key`** ✓（**不编** ✓）。
 */
export function boardsOf(connections: readonly ConnectionInfo[]): Board[] {
  const byKey = new Map<string, Board>();
  for (const connection of connections) {
    // **没绑板型包的连接不是板** ✓（本机 / 客机 ✓ —— 它们是「机器」，不是「板」 ✓）
    if (connection.boardPack === null) continue;
    const entry = byKey.get(connection.deviceKey);
    if (entry === undefined) {
      byKey.set(connection.deviceKey, {
        deviceKey: connection.deviceKey,
        boardPack: connection.boardPack,
        current: connection.current,
        connectionCount: 1,
      });
      continue;
    }
    // **只认第一条 `current`** ✓（**两处说「当前」就是数据乱了** ✓）
    if (!entry.current && connection.current) entry.current = true;
    entry.connectionCount += 1;
  }

  const boards = [...byKey.values()];
  // **当前那块排第一** ✓（**其余保持输入顺序** ✓）
  const currentFirst = boards.filter((board) => board.current);
  const rest = boards.filter((board) => !board.current);
  return [...currentFirst, ...rest];
}

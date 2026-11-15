import type { ConnectionInfo } from '../../shared/ipc-contract';

/**
 * **按设备分组**（板实物与连接是两层 ✓ —— 契约 `spec/02` §10.2 ✓）。
 *
 * ── 为什么要有这一层 ──
 *
 * → 一块板有 **ADB / 串口 / SSH** 三条连接 ✓ → **界面要按板子分组** ✓。
 * → 只按连接列的话，用户看到的是**三条连接**，不是**三块板** ✗。
 * → **`device_key` 就是「哪块板」** ✓ —— 同一块板的多条连接给同一个值 ✓。
 *
 * ── 三条规矩（**都是「不猜」** ✓）──
 *
 * | # | 规矩 | 为什么 |
 * |---|---|---|
 * | 1 | **设备的名字就是 `device_key`** ✓ | **不编一个名字出来** ✗ —— 三条连接的 label 各不相同（`板子 · ADB` / `板子 · 串口` / `板子 · SSH` ✓）→ **取哪个都是编** ✗ → **用它的身份** ✓ |
 * | 2 | **当前那块排第一** ✓ | 选板的人**先看到自己在用哪块** ✓ |
 * | 3 | **一组里只有一个「当前连接」** ✓ | 两处都说「当前」= **数据乱了** ✓ → **只认第一条** ✓（**不猜第二个是谁** ✓） |
 */

/** 一组设备（一块板 + 它的连接） */
export interface DeviceGroup {
  /** **这块板的标识** ✓（**它的名字也是这个** ✓ —— 不编 ✓） */
  deviceKey: string;
  /** 这块板上的连接 ✓（**按输入顺序** ✓） */
  connections: ConnectionInfo[];
  /** **当前运行时用的是哪条连接** ✓（**没有就是 `null`** ✓） */
  currentProfileId: string | null;
}

/**
 * 把连接按设备分组。
 *
 * → **当前那块排第一** ✓，其余按输入顺序 ✓。
 * → **设备的名字是 `device_key`** ✓（**不编** ✓）。
 */
export function groupByDevice(connections: readonly ConnectionInfo[]): DeviceGroup[] {
  const byKey = new Map<string, ConnectionInfo[]>();
  for (const connection of connections) {
    const list = byKey.get(connection.deviceKey);
    if (list === undefined) byKey.set(connection.deviceKey, [connection]);
    else list.push(connection);
  }

  const groups: DeviceGroup[] = [];
  for (const [deviceKey, list] of byKey) {
    // **一组里只认第一个 `current`** ✓（**两处说「当前」就是数据乱了** ✓）
    const current = list.find((c) => c.current);
    groups.push({
      deviceKey,
      connections: list,
      currentProfileId: current?.id ?? null,
    });
  }

  // **当前那块排第一** ✓（**其余保持输入顺序** ✓）
  const currentFirst = groups.filter((g) => g.currentProfileId !== null);
  const rest = groups.filter((g) => g.currentProfileId === null);
  return [...currentFirst, ...rest];
}

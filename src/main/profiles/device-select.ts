import { deviceKeyOf, type ConnectionProfile } from './schema';
import type { RuntimeStatus } from '../../shared/runtime-status';

/**
 * **选板子 = 宿主挑连接**（板实物与连接是两层 ✓ —— 契约 `spec/02` §10.2 ✓）。
 *
 * ── 为什么宿主挑 ──
 *
 * → 界面**只列板卡** ✓（用户 2026-11-16 明确：「仅支持板卡选择，
 *   当前有 fake 和 3588 的真版，不要把连接这些放进去」✓）
 * → 一块板有 **ADB / 串口 / SSH** 三条连接 ✓ → **哪条能用只有宿主知道** ✓
 * → 用户点的是**板** ✓ → **宿主挑一条能用的** ✓ → **界面不暴露连接** ✓。
 *
 * ── 三条规矩（**都是「不猜」** ✓）──
 *
 * | # | 规矩 | 为什么 |
 * |---|---|---|
 * | 1 | **已经在那块板上 → 不重连** ✓ | **白连一次会掉读数** ✗ —— 采样器会重起 ✓ |
 * | 2 | **挨个试这块板的连接** ✓ | **用户点的是板，不是某条通道** ✓ → 宿主挑一条 ✓ |
 * | 3 | **全都不行 → 报错** ✓ | **不静默地换一块板** ✗ —— 那是「静默地做另一件事」 ✗ |
 */

/** 宿主这边的依赖（**窄接口** ✓ —— 替身能进 ✓） */
export interface DeviceSelectDeps {
  /** 起运行时（连某条连接） */
  start(profile: ConnectionProfile): Promise<RuntimeStatus>;
  /** 当前运行时用的是哪条连接（**没有就是 `null`** ✓） */
  currentProfileId(): string | null;
}

/** 选板子的结果 */
export type DeviceSelectResult =
  | { ok: true; profileId: string; reused: boolean }
  | { ok: false; reason: 'not_found' | 'connect_failed'; detail: string };

/**
 * 切到**某块板**。
 *
 * → **候选 = 这块板的所有连接** ✓（`device_key` 相同 ✓ —— 契约 `spec/02` §10.2 ✓）
 * → **顺序 = profile 的顺序** ✓（**不按偏好排** ✓ —— 哪条先试是**声明顺序** ✓）
 * → **已经在上面 → 不动** ✓
 * → **都不行 → 说清楚每一条为什么失败** ✓（**不静默** ✓）。
 */
export async function selectDevice(
  profiles: readonly ConnectionProfile[],
  deviceKey: string,
  deps: DeviceSelectDeps,
): Promise<DeviceSelectResult> {
  const candidates = profiles.filter((profile) => deviceKeyOf(profile) === deviceKey);
  if (candidates.length === 0) {
    return { ok: false, reason: 'not_found', detail: `没有这个设备：${deviceKey}` };
  }

  // ── **已经在那块板上 → 不重连** ✓ ──
  // → **白连一次会掉读数** ✗ —— 采样器会重起 ✓ → 界面会闪一下 ✗
  const current = deps.currentProfileId();
  if (current !== null) {
    const already = candidates.find((profile) => profile.id === current);
    if (already !== undefined) return { ok: true, profileId: already.id, reused: true };
  }

  // ── **挨个试** ✓ ──
  const failures: string[] = [];
  for (const profile of candidates) {
    const status = await deps.start(profile);
    if (status.state === 'running') {
      return { ok: true, profileId: profile.id, reused: false };
    }
    failures.push(`${profile.id}（${profile.label}）：${status.detail ?? status.state}`);
  }

  return {
    ok: false,
    reason: 'connect_failed',
    detail: `连不上这块板（试了 ${candidates.length} 条连接）：${failures.join('；')}`,
  };
}

import { deviceKeyOf, type ConnectionProfile } from './schema';
import type { RuntimeStatus } from '../../shared/runtime-status';

/**
 * Choosing a board = the host picks the connection (the physical board and
 * the connection are two layers ✓ — contract `spec/02` §10.2 ✓).
 *
 * ── Why the host picks ──
 *
 * → The interface lists only the board cards ✓ (the user was explicit on
 *   2026-11-16: "only board card selection is supported, there are real
 *   versions of fake and of the 3588, do not put the connections and such in
 *   there" ✓)
 * → One board has three connections: ADB / serial / SSH ✓ → only the host
 *   knows which one works ✓
 * → What the user clicks is the board ✓ → the host picks one that works ✓
 *   → the interface never exposes a connection ✓.
 *
 * ── Three rules (all of them "never guess" ✓) ──
 *
 * | # | Rule | Why |
 * |---|---|---|
 * | 1 | Already on that board → do not reconnect ✓ | Connecting for nothing drops the readings ✗ — the sampler restarts ✓ |
 * | 2 | Try the connections of this board one by one ✓ | What the user clicked is the board, not a particular channel ✓ → the host picks one ✓ |
 * | 3 | None of them works → report an error ✓ | Silently swapping in another board ✗ — that is "silently doing something else" ✗ |
 */

/** The host-side dependencies (a narrow interface ✓ — a test double fits in ✓) */
export interface DeviceSelectDeps {
  /** Start the runtime (over some connection) */
  start(profile: ConnectionProfile): Promise<RuntimeStatus>;
  /** Which connection the current runtime uses (`null` when there is none ✓) */
  currentProfileId(): string | null;
}

/** The result of choosing a board */
export type DeviceSelectResult =
  | { ok: true; profileId: string; reused: boolean }
  | { ok: false; reason: 'not_found' | 'connect_failed'; detail: string };

/**
 * Switch to a board.
 *
 * → The candidates = all the connections of this board ✓ (the same
 *   `device_key` ✓ — contract `spec/02` §10.2 ✓)
 * → The order = the order of the profiles ✓ (not sorted by preference ✓ —
 *   which one is tried first is the declaration order ✓)
 * → Already on it → nothing happens ✓
 * → None of them works → say clearly why each one failed ✓ (never silent ✓).
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

  // ── Already on that board → do not reconnect ✓ ──
  // → Connecting for nothing drops the readings ✗ — the sampler restarts ✓
  //   → the interface flickers ✗
  const current = deps.currentProfileId();
  if (current !== null) {
    const already = candidates.find((profile) => profile.id === current);
    if (already !== undefined) return { ok: true, profileId: already.id, reused: true };
  }

  // ── Try them one by one ✓ ──
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

import { describe, it, expect } from 'vitest';
import { selectDevice } from '../../../src/main/profiles/device-select';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';
import type { RuntimeStatus } from '../../../src/shared/runtime-status';

/**
 * **Picking a board = the host picks the connection** (the board itself and
 * the connection are two layers — contract `spec/02` §10.2).
 *
 * Why the host picks:
 *
 * → The interface **lists only the boards** (the operator said so explicitly
 *   on 2026-11-16: "only the selection of a board is supported, do not put
 *   the connections into it").
 * → One board has **three connections, ADB / serial / SSH**, and **only the
 *   host knows which one works**.
 * → The interface picks → **it does not silently do something else** →
 *   **when it cannot connect it has to say so**.
 *
 * Three rules:
 *
 * | # | Rule | Why |
 * |---|---|---|
 * | 1 | **already on that board → it does not connect again** | **a pointless connection loses the readings** — the sampler restarts |
 * | 2 | **the connections of that board are tried one by one** | **the operator clicks a board, not a channel** → the host picks one that works |
 * | 3 | **none of them works → it reports an error** | **it does not silently switch to another board** |
 */

/** A connection profile (**only the fields that are used here**) */
function profile(id: string, deviceKey: string, label = id): ConnectionProfile {
  return {
    id,
    label,
    transport: 'adb',
    board_pack: 'rk3588-atk',
    device_key: deviceKey,
    options: {},
  };
}

const ATK: ConnectionProfile[] = [
  profile('board-adb', 'atk-01', 'board · ADB'),
  profile('board-serial', 'atk-01', 'board · serial'),
  profile('board-ssh', 'atk-01', 'board · SSH'),
  profile('fake-board', 'fake-board', 'fake board · synthetic data'),
];

/** One record of "starting the runtime" — it asserts which connections the host really tried */
interface Attempt {
  profileId: string;
  status: RuntimeStatus;
}

function runtime(
  results: Record<string, RuntimeStatus>,
  current: string | null = null,
): { attempts: Attempt[]; deps: Parameters<typeof selectDevice>[2] } {
  const attempts: Attempt[] = [];
  return {
    attempts,
    deps: {
      currentProfileId: () => current,
      start: async (p: ConnectionProfile) => {
        const status = results[p.id] ?? { state: 'error', detail: `no result was arranged for ${p.id}` };
        attempts.push({ profileId: p.id, status });
        return status;
      },
    },
  };
}

describe('picking a board', () => {
  it('**a board → the host picks its first connection** (**the operator clicks a board, not a channel**)', async () => {
    const rt = runtime({ 'board-adb': { state: 'running' } });
    const result = await selectDevice(ATK, 'atk-01', rt.deps);
    expect(result).toEqual({ ok: true, profileId: 'board-adb', reused: false });
    expect(rt.attempts.map((a) => a.profileId)).toEqual(['board-adb']);
  });

  it('**already on that board → it does not connect again** (a pointless connection loses the readings)', async () => {
    const rt = runtime({}, 'board-ssh');
    const result = await selectDevice(ATK, 'atk-01', rt.deps);
    expect(result).toEqual({ ok: true, profileId: 'board-ssh', reused: true });
    // **It was never started** — the sampler was not restarted
    expect(rt.attempts).toEqual([]);
  });

  it('**the first one cannot be reached → the next one is tried** (**the board has other channels**)', async () => {
    const rt = runtime({
      'board-adb': { state: 'error', detail: 'adb: device not found' },
      'board-serial': { state: 'error', detail: 'the serial port COM3 does not exist' },
      'board-ssh': { state: 'running' },
    });
    const result = await selectDevice(ATK, 'atk-01', rt.deps);
    expect(result).toEqual({ ok: true, profileId: 'board-ssh', reused: false });
    expect(rt.attempts.map((a) => a.profileId)).toEqual([
      'board-adb',
      'board-serial',
      'board-ssh',
    ]);
  });

  it('**none of them works → it reports an error** (**it does not silently switch to another board**)', async () => {
    const rt = runtime({
      'board-adb': { state: 'error', detail: 'adb: device not found' },
    });
    const result = await selectDevice(ATK, 'atk-01', rt.deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('connect_failed');
    // **It states that every one of them was tried** — not a vague "it failed"
    expect(result.detail).toContain('board-adb');
    expect(result.detail).toContain('board-ssh');
  });

  it('**there is no such device → not_found** (**it does not guess**)', async () => {
    const rt = runtime({});
    const result = await selectDevice(ATK, 'atk-99', rt.deps);
    expect(result).toEqual({ ok: false, reason: 'not_found', detail: 'no such device: atk-99' });
    expect(rt.attempts).toEqual([]);
  });

  it('**a fake board is a board as well** (**its connections are its own**)', async () => {
    const rt = runtime({ 'fake-board': { state: 'running' } });
    const result = await selectDevice(ATK, 'fake-board', rt.deps);
    expect(result).toEqual({ ok: true, profileId: 'fake-board', reused: false });
  });

  it('**a profile without `device_key` is filed under its own name** (**the old way of one board and one link**)', async () => {
    const legacy: ConnectionProfile = {
      id: 'legacy-ssh',
      label: 'the old connection',
      transport: 'ssh',
      board_pack: 'rk3588-atk',
      options: {},
    };
    const rt = runtime({ 'legacy-ssh': { state: 'running' } });
    const result = await selectDevice([legacy], 'legacy-ssh', rt.deps);
    expect(result).toEqual({ ok: true, profileId: 'legacy-ssh', reused: false });
  });
});

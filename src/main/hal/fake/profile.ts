import type { ConnectionProfile } from '../../profiles/schema';

/**
 * ⚠️ **The fake device** — its profile is **made up in memory, never written to
 * disk**.
 *
 * → There is never a persistent "fake profile" in the repository
 * (`profiles/targets/` stays clean ✓).
 *
 * Pointing `board_pack` at `rk3588-atk` is **mandatory**: the candidate
 * selection only keeps the profiles with `board_pack != null`
 * (`tags/runtime.ts`) → without it it is not selected.
 * And once `board_pack` is named, **`/proc/device-tree/model` is not read** →
 * the fake device does not have to fake a model number ✓.
 */

/** The id of the fake profile (it is also the connection's id). */
export const FAKE_PROFILE_ID = 'fake-board';

/** What the environment says. */
export type FakeMode = 'off' | 'on' | 'only';

export function fakeMode(env: NodeJS.ProcessEnv = process.env): FakeMode {
  const raw = (env['COCKPIT_FAKE'] ?? '').trim().toLowerCase();
  if (raw === 'only') return 'only';
  if (raw === 'off' || raw === '0' || raw === 'false') return 'off';
  // **On by default** ✓ (the user decided it on 2026-11-21 ✓ — the fake board
  // ships with the application ✓) — `COCKPIT_FAKE=off` turns it off ✓.
  return 'on';
}

/**
 * The fake device has to play **several** roles
 * (`COCKPIT_FAKE_PROFILES=build,target`).
 *
 * ── Why several are needed now ──
 *
 * The workflow layer has to run between **two targets** (the guest → the
 * board ✓), and **every fake board has its own virtual disk**
 * (`fakeFilesystem(profile.id)` ✓) → two roles = **two disks** ✓ = two
 * profile ids ✓.
 *
 * → **By default there is only one** (`fake-board` ✓) → the behaviour is
 * exactly as it was before ✓.
 */
export function fakeProfileIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env['COCKPIT_FAKE_PROFILES'] ?? '').trim();
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return ids.length === 0 ? [FAKE_PROFILE_ID] : [...new Set(ids)];
}

/** The fake profile (in memory, never written to disk). */
export function fakeProfile(id: string = FAKE_PROFILE_ID): ConnectionProfile {
  return {
    id,
    label: id === FAKE_PROFILE_ID ? 'fake board · synthetic data' : `fake target · ${id} · synthetic data`,
    // **Pretends to be an ssh target** (the capability bits are the same as for `local` ✓):
    // The workflow layer has one hard rule: "**a role must not be bound to `local`**" —
    // `local` is **the shell of the host itself** ✗, and the fake device must not take that path either ✓.
    transport: 'ssh',
    board_pack: 'rk3588-atk',
    // **Which board this is** ✓ (contract `spec/02` §10.2 ✓) —
    // **Every fake target is a board** ✓ (**it has its own virtual disk** ✓ — `fakeFilesystem(profile.id)` ✓)
    // → **written out explicitly** ✓ (**do not rely on a default** ✓ — the e2e has to match ✓)
    device_key: id,
    options: {
      /**
             * **The pipe mode** (not pty).
             *
             * In the pty mode the host **only forwards the raw keys** (xterm sends one
             * key as one byte),
             * so `uname` arrives in the session as the five characters 'u','n','a','m','e' —
             * the command never matches, and there is no prompt and no echo
             * (those are what the host does in the pipe mode:
             * `terminal/line-editor.ts`).
             */
      pty: false,
      prompt: 'fake@rk3588',
    },
  };
}

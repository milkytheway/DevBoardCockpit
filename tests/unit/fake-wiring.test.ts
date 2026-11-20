import { describe, it, expect } from 'vitest';
import { profilesWithFake, fakeRouteFor } from '../../src/main/hal/fake/wiring';
import { FAKE_PROFILE_ID } from '../../src/main/hal/fake/profile';
import type { ConnectionProfile } from '../../src/main/profiles/schema';

/**
 * The **rules of the wiring** of the fake device (pure functions, so they can
 * be unit tested).
 *
 * Why the rules are a file of their own:
 *
 * `main/index.ts` pulls in Electron and **a unit test cannot get in** — and
 * these rules are exactly where the "silent failure" happens: when the fake
 * device did not load, the profile is still in the list while the connection
 * falls back to a **real local connection** (on Windows that is the cmd.exe of
 * the developer): the list says "fake board · synthetic data" and opening it
 * gives the developer their own machine.
 *
 * → The rules are pure functions, so **the criteria can be unit tested**.
 */

const REAL: ConnectionProfile = {
  id: 'board-adb',
  label: 'the real board',
  transport: 'adb',
  board_pack: 'rk3588-atk',
  options: {},
};

describe('the fake device · the rules of the wiring', () => {
  it('the switch is off → the fake profile is not listed', () => {
    expect(profilesWithFake([REAL], 'off', true)).toEqual([REAL]);
  });

  it('it is on → the fake profile comes first (during the debugging it is what you see)', () => {
    const out = profilesWithFake([REAL], 'on', true);
    expect(out[0]?.id).toBe(FAKE_PROFILE_ID);
    expect(out).toHaveLength(2);
  });

  it('only → only the fake profile', () => {
    const out = profilesWithFake([REAL], 'only', true);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe(FAKE_PROFILE_ID);
  });

  it('the fake device did not load → it is not listed (listing it would let a real local connection take its place)', () => {
    expect(profilesWithFake([REAL], 'on', false)).toEqual([REAL]);
    expect(profilesWithFake([REAL], 'only', false)).toEqual([REAL]);
  });

  it('**several roles** (`COCKPIT_FAKE_PROFILES=build,target`) → each of them goes to the fake device', () => {
    const env = { COCKPIT_FAKE_PROFILES: 'build,target' } as NodeJS.ProcessEnv;
    const out = profilesWithFake([REAL], 'only', true, env);
    expect(out.map((p) => p.id)).toEqual(['build', 'target']);
    expect(fakeRouteFor('build', 'on', true, env)).toBe('fake');
    expect(fakeRouteFor('target', 'on', true, env)).toBe('fake');
    // **One that is not in the list → it is still a real profile**
    expect(fakeRouteFor('board-adb', 'on', true, env)).toBe('not-fake');
  });

  it('the list of roles is **not given** → by default only `fake-board` (the behaviour is the one of before)', () => {
    expect(fakeRouteFor('build', 'on', true, {} as NodeJS.ProcessEnv)).toBe('not-fake');
    expect(fakeRouteFor(FAKE_PROFILE_ID, 'on', true, {} as NodeJS.ProcessEnv)).toBe('fake');
  });

  it('the routing: the fake device is only used when it loaded, and when it did not load it is **refused**, it never falls back to a real connection', () => {
    expect(fakeRouteFor(FAKE_PROFILE_ID, 'on', true)).toBe('fake');
    // **'refuse' and not 'not-fake'** — the latter would fall through to the real transport
    expect(fakeRouteFor(FAKE_PROFILE_ID, 'on', false)).toBe('refuse');
    expect(fakeRouteFor('board-adb', 'on', true)).toBe('not-fake');
    expect(fakeRouteFor('board-adb', 'off', true)).toBe('not-fake');
  });
});

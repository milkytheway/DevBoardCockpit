import type { ConnectionProfile } from '../../profiles/schema';
import { fakeProfile, fakeProfileIds, type FakeMode } from './profile';

/**
 * The **wiring rules of the fake device** — pure functions, so they can be
 * unit tested.
 *
 * ── Why the rules are a file of their own ──
 *
 * `main/index.ts` imports Electron, so **a unit test cannot reach it** —
 * and these rules are exactly where a silent failure is most likely:
 *
 * When the fake device fails to load, the profile is still in the list, but
 * the connection falls back to a **real local connection** (on Windows that is
 * the developer's own cmd.exe):
 * the list says "fake board · synthetic data", but opening it gives you your
 * own machine, and the numbers on the panel are **the numbers of the real
 * machine**.
 *
 * → The rules are extracted into pure functions, **so that the criterion can
 * be unit tested**.
 */

/**
 * The connection list, with the fake board spliced in.
 *
 * @param profiles The real profiles (from disk).
 * @param mode The switch.
 * @param fakeReady Did the fake device actually load?
 *   **When it did not load it is not listed**: listing it while a real
 *   connection takes its place is worse than not listing it.
 */
export function profilesWithFake(
  profiles: ConnectionProfile[],
  mode: FakeMode,
  fakeReady: boolean,
  env: NodeJS.ProcessEnv = process.env,
): ConnectionProfile[] {
  if (mode === 'off') return profiles;
  if (!fakeReady) return profiles;
  // **The fake device can play several roles** (`COCKPIT_FAKE_PROFILES=build,target` ✓)
  const fakes = fakeProfileIds(env).map((id) => fakeProfile(id));
  return mode === 'only' ? fakes : [...fakes, ...profiles];
}

/** What to do with a profile id. */
export type FakeRoute = 'fake' | 'refuse' | 'not-fake';

/**
 * Which way this profile has to go.
 *
 * - `fake` —— it goes through the fake device;
 * - `refuse` —— it is **explicitly refused** (the fake device did not load);
 * - `not-fake` —— a profile that is not the fake device, it goes through the
 *   normal transport.
 *
 * **`refuse` and `not-fake` have to be separate**:
 * mixed together, "the fake device did not load" would fall into the normal
 * transport, and the user would see **the shell of his own machine**
 * (`transport: 'local'`) — labelled "synthetic data" while it is the real
 * machine.
 */
export function fakeRouteFor(
  profileId: string,
  mode: FakeMode,
  fakeReady: boolean,
  env: NodeJS.ProcessEnv = process.env,
): FakeRoute {
  if (!fakeProfileIds(env).includes(profileId)) return 'not-fake';
  if (mode === 'off') return 'not-fake';
  return fakeReady ? 'fake' : 'refuse';
}

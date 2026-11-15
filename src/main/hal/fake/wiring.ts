import type { ConnectionProfile } from '../../profiles/schema';
import { fakeProfile, fakeProfileIds, type FakeMode } from './profile';

/**
 * 假设备的**接线规则** —— 纯函数，所以能单测。
 *
 * ── 为什么规则要单独成文件 ──
 *
 * `main/index.ts` 引了 Electron，**单测进不去**——
 * 而这几条恰恰是「静默失效」的重灾区：
 *
 * 假设备没载入成功时，profile 还在列表里，
 * 而连接回落成了**真本机连接**（Windows 上就是开发者自己的 cmd.exe）：
 * 列表里写着「假板子 · 合成数据」，打开却是自己的机器，
 * 面板上的数还是**真机器的数**。
 *
 * → 规则抽成纯函数，**判据能单测**。
 */

/**
 * The connection list, with the fake board spliced in.
 *
 * @param profiles The real profiles (from disk).
 * @param mode The switch.
 * @param fakeReady Did the fake device actually load?
 *   **没载入成功 → 就不列它**：列了却拿真连接顶替，比不列更坏。
 */
export function profilesWithFake(
  profiles: ConnectionProfile[],
  mode: FakeMode,
  fakeReady: boolean,
  env: NodeJS.ProcessEnv = process.env,
): ConnectionProfile[] {
  if (mode === 'off') return profiles;
  if (!fakeReady) return profiles;
  // **假设备可以扮多个角色**（`COCKPIT_FAKE_PROFILES=build,target` ✓）
  const fakes = fakeProfileIds(env).map((id) => fakeProfile(id));
  return mode === 'only' ? fakes : [...fakes, ...profiles];
}

/** What to do with a profile id. */
export type FakeRoute = 'fake' | 'refuse' | 'not-fake';

/**
 * 这个 profile 该走哪条路。
 *
 * - `fake` —— 走假设备；
 * - `refuse` —— **明确拒绝**（假设备没载入成功）；
 * - `not-fake` —— 不是假设备的 profile，走正常传输。
 *
 * **`refuse` 与 `not-fake` 必须分开**：
 * 混在一起的话，「假设备没载入成功」就会掉进正常传输里，
 * 于是用户看到的是**自己机器的 shell**（`transport: 'local'`）——
 * 标着「合成数据」，其实是真机器。
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

import type { ConnectionProfile } from '../../profiles/schema';

/**
 * ⚠️ **假设备** —— 它的 profile 是**内存里造的，不落盘**。
 *
 * → 仓库里永远没有「假 profile」这个持久物（`profiles/targets/` 是干净的 ✓）。
 *
 * `board_pack` 指向 `rk3588-atk` 是**必须的**：候选挑选只留
 * `board_pack != null` 的 profile（`tags/runtime.ts`）→ 不指就选不上。
 * 而 `board_pack` 指名之后**不会去读 `/proc/device-tree/model`** →
 * 假设备不需要伪造型号 ✓。
 */

/** The id of the fake profile (it is also the connection's id). */
export const FAKE_PROFILE_ID = 'fake-board';

/** What the environment says. */
export type FakeMode = 'off' | 'on' | 'only';

export function fakeMode(env: NodeJS.ProcessEnv = process.env): FakeMode {
  const raw = (env['COCKPIT_FAKE'] ?? '').trim().toLowerCase();
  if (raw === 'only') return 'only';
  if (raw === '1' || raw === 'on' || raw === 'true') return 'on';
  return 'off';
}

/** The fake profile (in memory, never written to disk). */
export function fakeProfile(): ConnectionProfile {
  return {
    id: FAKE_PROFILE_ID,
    label: '假板子 · 合成数据',
    transport: 'local',
    board_pack: 'rk3588-atk',
    options: {
      /**
       * **pipe 模式**（不是 pty）。
       *
       * pty 模式下宿主**只转发裸键**（xterm 一个键一个字节），
       * 于是 `uname` 到会话里是 'u','n','a','m','e' 五个字符——
       * 命令永远匹配不上，而且没有提示符、没有回显
       * （那些是 pipe 模式宿主做的事：`terminal/line-editor.ts`）。
       */
      pty: false,
      prompt: 'fake@rk3588',
    },
  };
}

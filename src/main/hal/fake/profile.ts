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

/**
 * 假设备要扮**几个**角色（`COCKPIT_FAKE_PROFILES=build,target`）。
 *
 * ── 为什么现在需要多个 ──
 *
 * 流程层要在**两个目标**之间跑（客机 → 板子 ✓），
 * 而**每块假板子有自己的虚拟盘**（`fakeFilesystem(profile.id)` ✓）→
 * 两个角色 = **两块盘** ✓ = 两个 profile id ✓。
 *
 * → **默认只有一个**（`fake-board` ✓）→ 行为与从前完全一样 ✓。
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
    label: id === FAKE_PROFILE_ID ? '假板子 · 合成数据' : `假目标 · ${id} · 合成数据`,
    // **假装自己是一个 ssh 目标**（能力位与 `local` 一样 ✓）：
    // 流程层有一条硬规矩「**角色不许绑到 `local`**」——
    // `local` 是**宿主自己的 shell** ✗，假设备也不该走那条路 ✓。
    transport: 'ssh',
    board_pack: 'rk3588-atk',
    // **这块板是哪块板** ✓（契约 `spec/02` §10.2 ✓）——
    // **每个假目标就是一块板** ✓（**它有自己的虚拟盘** ✓ —— `fakeFilesystem(profile.id)` ✓）
    // → **显式写出来** ✓（**别靠缺省** ✓ —— e2e 里要对得上 ✓）
    device_key: id,
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

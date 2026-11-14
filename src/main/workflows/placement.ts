/**
 * 落位语义（placement）—— **封闭词表**。
 *
 * ── 为什么要有它 ──
 *
 * 「把产物放到板子上的**规范位置**」这句话里的「规范位置」**每块板不一样**：
 * 内核模块要去 `/usr/lib/modules/<版本>/extra/`，用户态程序要去 `/usr/local/bin/`。
 * → **写死在流程包里 = 换板子就要改流程** ✗；
 * → **写死成路径 = 流程包不认识板子的规矩** ✗。
 *
 * → 所以流程包只说「**落到内核模块该去的地方**」（`placement: kernel-module`），
 * **路径由宿主按板子的规矩解析** ✓。
 *
 * ── 封闭 = 拼错要报错 ──
 *
 * 拼错 `kernel-module` 写成 `kernel_modle` → **报错**，
 * 不能默默回落到「随便找个地方放」（那会把 `.ko` 丢在 `/tmp` 里，
 * 然后 `modprobe` 找不到它，而流程**报成功** ✗）。
 */

/** 落位词表（**封闭**） */
export const PLACEMENTS = {
  'kernel-module': {
    /** 目录模板；`{kernel_release}` 由宿主按目标机器的实际内核版本填 */
    dir: '/usr/lib/modules/{kernel_release}/extra/',
    /** 人话说明（写进错误信息与时间线） */
    doc: '内核模块 → /usr/lib/modules/<版本>/extra/（放置规范 §4 硬规矩 1）',
  },
  'user-program': {
    dir: '/usr/local/bin/',
    doc: '用户态可执行文件 → /usr/local/bin/',
  },
} as const;

export type PlacementId = keyof typeof PLACEMENTS;

export const PLACEMENT_IDS = Object.keys(PLACEMENTS) as PlacementId[];

/** 这个词在封闭词表里吗 */
export function isPlacement(id: string): id is PlacementId {
  return Object.hasOwn(PLACEMENTS, id);
}

/** 解析落位目录（`kernel-module` 要知道目标机器的内核版本） */
export function placementDir(id: PlacementId, facts: { kernel_release: string }): string {
  const template = PLACEMENTS[id].dir;
  return template.replace('{kernel_release}', facts.kernel_release);
}

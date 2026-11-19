import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 路径解析。
 *
 * 规矩（AGENTS.md §3）：**路径写绝对路径**；Windows 宿主用 `C:\...`。
 * 机器专属路径只在这里与 `profiles/settings.json` 出现，不进代码（事实清单 §2）。
 */

const DEFAULT_APP = 'DevBoardCockpit';

/** 用户数据目录：Windows 用 %LOCALAPPDATA%，其他平台用 XDG 约定 */
export function userDataDir(appName: string = DEFAULT_APP): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData && localAppData.length > 0) {
    return join(localAppData, appName);
  }
  if (process.platform === 'win32') {
    // Windows 上没有 LOCALAPPDATA 时退回用户目录
    return join(homedir(), 'AppData', 'Local', appName);
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), appName);
}

/** 内置连接 profile 目录（随应用分发，只读） */
export function builtinProfilesDir(appRoot: string): string {
  return join(appRoot, 'profiles', 'targets');
}

/** 用户自己的连接 profile 目录（可写） */
export function userProfilesDir(appName: string = DEFAULT_APP): string {
  return join(userDataDir(appName), 'profiles', 'targets');
}

/**
 * 卡片根目录（用户自己的那一份）。
 *
 * 人与 agent 的卡都放这儿。
 */
export function cardRootsDir(appName: string = DEFAULT_APP): string {
  return join(userDataDir(appName), 'cards');
}

/**
 * **内置**的卡片目录（随应用分发的那一批 ✓）。
 *
 * → 与 `profiles/` 那些同处一个思路 ✓：**随应用来的** ✓ —— **只读** ✓。
 */
export function builtinCardsDir(appRoot: string): string {
  return join(appRoot, 'cards');
}

/**
 * 卡片存储目录。
 *
 * ── 必须是**兄弟目录**，不能塞在卡片根目录里面 ──
 *
 * 卡片根目录被 `fs.watch` 盯着（热插拔）。
 * 存储写在根目录里 → 写一次 `storage.json` 就触发一次 `refresh` +
 * `cardsChanged` → 页面重取清单 → **回路**。
 *
 * → 存储放在 `card-storage/`，与 `cards/` 平级。
 */
export function cardStorageDir(appName: string = DEFAULT_APP): string {
  return join(userDataDir(appName), 'card-storage');
}

/**
 * **内置**的流程包目录（随应用分发的那一批 ✓）。
 *
 * → 与 `profiles/boards/`（板型包）、`profiles/targets/`（连接 profile）**同处** ✓：
 * 「宿主侧的数据文件都在 `profiles/` 下」✓。
 */
export function builtinWorkflowsDir(appRoot: string): string {
  return join(appRoot, 'profiles', 'workflows');
}

/**
 * 用户自己的流程包目录（**放这儿 ≠ 能跑** ✓ —— 能不能跑看**权限区** ✓）。
 *
 * → 与卡片目录同一个道理：**「放在那儿」只是「候选」**，
 * 闸在设置里的统一权限区（`03` §2.4 ✓ · ADR-D47 ✓）。
 */
export function userWorkflowsDir(appName: string = DEFAULT_APP): string {
  return join(userDataDir(appName), 'workflows');
}

/**
 * **用户自己的板型包目录**（可写 ✓）。
 *
 * ── 为什么它以前不存在（**2026-11-19 补上** ✓）──
 *
 * → **板型包是唯一「只有内置、没有用户」的** ✗ —— 而**连接 profile** ✓（`userProfilesDir` ✓）
 *   · **卡片** ✓（`cardRootsDir` ✓）· **流程包** ✓（`userWorkflowsDir` ✓）**都有两份** ✓。
 * → **后果**：**用户自己往用户数据目录放一份板型包，运行时读不到** ✗
 *   （运行时只读 asar 里那一个 ✓ —— `src/main/index.ts:210` ✓）
 *   → **向导实例化出来的包落地即废** ✗。
 * → **所以它补上** ✓ —— 与那三样**同款规矩** ✓（**用户目录在后 → 同 id 时用户优先** ✓）。
 */
export function userBoardsDir(appName: string = DEFAULT_APP): string {
  return join(userDataDir(appName), 'boards');
}

/** 会话日志目录 */
export function logDir(appName: string = DEFAULT_APP): string {
  return join(userDataDir(appName), 'logs');
}

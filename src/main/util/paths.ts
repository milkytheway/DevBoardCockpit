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

/** 会话日志目录 */
export function logDir(appName: string = DEFAULT_APP): string {
  return join(userDataDir(appName), 'logs');
}

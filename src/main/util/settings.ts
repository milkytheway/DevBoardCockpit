import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 宿主设置。
 *
 * **机器专属路径只在这里与 `profiles/settings.json` 出现，不进代码**
 * （事实清单 §2：宿主 adb 不在 PATH，`where adb` 查不到）。
 */

export interface HostTools {
  /** adb 可执行文件的绝对路径。null = 让运行时按 PATH → 常见位置找 */
  adb: string | null;
}

export interface AppSettings {
  name: string;
  dataDirName: string;
}

export interface Settings {
  hostTools: HostTools;
  app: AppSettings;
}

const DEFAULT_SETTINGS: Settings = {
  hostTools: { adb: null },
  app: { name: 'DevBoardCockpit', dataDirName: 'DevBoardCockpit' },
};

/**
 * **设置文件的路径**（**一个入口** ✓ —— CLI 与应用不许各找各的 ✓）。
 *
 * ── 为什么要收口 ──
 *
 * 之前：应用走 `join(app.getAppPath(), 'profiles', 'settings.json')` ✓，
 * 而 CLI（`scripts/run-workflow.ts` 等）**不读设置** ✗
 * → CLI 建连接时 `adbPath` 是 `undefined` ✗ → 回落成 `'adb'` ✗
 * → **宿主 adb 不在 PATH** ✗ → `spawn adb ENOENT` ✗
 * → 「编译上板」那条流程在 CLI 里**根本跑不起来** ✗
 * （而**应用里是好的** ✗ → **两份真相** ✗ ——本工程栽过好几次的同款坑 ✓）。
 *
 * → 现在**谁来建连接，谁就按同一条路拿 adb 路径** ✓。
 *
 * @param root 根目录。**应用传 `app.getAppPath()`** ✓；**CLI 传 cwd** ✓。
 */
export function settingsPath(root?: string): string {
  return join(root ?? process.cwd(), 'profiles', 'settings.json');
}

/**
 * 读 `profiles/settings.json`。
 *
 * 文件不存在或坏了就返回默认值——设置读不到不该让应用起不来。
 */
export function loadSettings(settingsPath: string): Settings {
  try {
    const raw = readFileSync(settingsPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SETTINGS;
    const obj = parsed as Record<string, unknown>;
    const tools = (obj['hostTools'] ?? {}) as Record<string, unknown>;
    const app = (obj['app'] ?? {}) as Record<string, unknown>;
    return {
      hostTools: {
        adb: typeof tools['adb'] === 'string' ? tools['adb'] : null,
      },
      app: {
        name: typeof app['name'] === 'string' ? app['name'] : DEFAULT_SETTINGS.app.name,
        dataDirName:
          typeof app['dataDirName'] === 'string'
            ? app['dataDirName']
            : DEFAULT_SETTINGS.app.dataDirName,
      },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * 找 adb 可执行文件。
 *
 * 顺序：`settings.json` 里的绝对路径 → PATH → 常见安装位置。
 * 都找不到就返回 'adb'，让 spawn 报「找不到」——那是个能看懂的错。
 */
export function resolveAdbPath(settings: Settings): string {
  const configured = settings.hostTools.adb;
  if (configured && existsSync(configured)) return configured;

  // 常见安装位置（这台机器的 adb 在 Downloads 下）
  const common = [
    join(process.env['USERPROFILE'] ?? '', 'Downloads', 'platform-tools', 'adb.exe'),
    join(process.env['USERPROFILE'] ?? '', 'AppData', 'Local', 'Android', 'Sdk',
      'platform-tools', 'adb.exe'),
  ];
  for (const p of common) {
    if (p && existsSync(p)) return p;
  }
  // **`platform-tools_r33.0.3-windows` 这种带版本号的目录** ✓
  // ——实测这台机器的 adb 就在这儿 ✓（不带版本号的那条找不到 ✓）。
  // 用 `readdirSync` 扫一眼 Downloads ✓（**不 glob** ✓ —— glob 还得引依赖 ✓）。
  try {
    const downloads = join(process.env['USERPROFILE'] ?? '', 'Downloads');
    const candidates = readdirSync(downloads)
      .filter((name) => name.startsWith('platform-tools'))
      .map((name) => join(downloads, name, 'platform-tools', 'adb.exe'));
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  } catch {
    // 目录读不到就算了 —— 下面是最后一档
  }
  return 'adb';
}

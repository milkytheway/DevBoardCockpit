import { existsSync, readFileSync } from 'node:fs';
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
  return 'adb';
}

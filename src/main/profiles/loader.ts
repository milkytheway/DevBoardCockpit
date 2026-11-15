import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProfile, deviceKeyConflicts, type ConnectionProfile } from './schema';

/**
 * 连接 profile 的加载。
 *
 * 两个来源：**内置目录**（随应用分发，只读）与**用户目录**（可写）。
 * 同 id 时**用户优先**——用户能覆盖内置 profile，这是「零代码改配置」的前提
 * （旧工程最顺手的加板路径：把 JSON 丢进用户目录，重启，板子出现）。
 *
 * **坏文件不拖垮其余**：一个写坏的 profile 只会被跳过并记一条警告。
 * 用户不该因为一个 typo 就整个应用起不来。
 */

export interface LoadProfilesOptions {
  /** 内置目录，绝对路径 */
  builtinDir: string;
  /** 用户目录，绝对路径。不存在就跳过 */
  userDir?: string;
  /** 记警告的出口，默认 console.warn */
  warn?: (message: string) => void;
}

function readDir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

export function loadProfiles(opts: LoadProfilesOptions): ConnectionProfile[] {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const merged = new Map<string, ConnectionProfile>();

  const collect = (dir: string | undefined): void => {
    if (!dir) return;
    for (const file of readDir(dir)) {
      const path = join(dir, file);
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
        const profile = parseProfile(parsed, path);
        merged.set(profile.id, profile);
      } catch (err) {
        warn(`跳过坏的 profile ${path}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  // 先内置，后用户——同 id 时用户的覆盖内置的
  collect(opts.builtinDir);
  collect(opts.userDir);

  const list = Array.from(merged.values()).sort((a, b) => a.id.localeCompare(b.id));

  // **同一个 `device_key` 声明了不同的板型包** ✓ → **说一声** ✓
  // → **不拖垮应用** ✓（同「坏文件只跳过一个」✓ —— 用户不该因为一个 typo 就起不来 ✓）
  for (const conflict of deviceKeyConflicts(list)) {
    warn(
      `device_key '${conflict.device_key}' 同时声明了板型包 ${conflict.board_packs.join(' / ')}` +
        `（牵涉 ${conflict.profile_ids.join(' / ')}）—— 一块板只有一个型号 ✓`,
    );
  }

  return list;
}

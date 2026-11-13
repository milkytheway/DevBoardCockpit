import { watch, type FSWatcher } from 'node:fs';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CardRoot } from './roots';

/**
 * 卡片目录的监听（热插拔）。
 *
 * ── 为什么不用 chokidar ──
 *
 * 一个依赖换来「递归监听 + 去抖 + 跨平台」，而我们只需要
 * 「卡片根目录变了 + 每个卡片目录变了」这两件事。
 * **`fs.watch` 够用**（Electron 跑在 Node 上，它有 `recursive` 选项，
 * 但**不是所有平台都支持**——所以只监听一层 + 每个卡片目录各挂一个）。
 *
 * ── 去抖 ──
 *
 * 一次保存可能触发**好几个**事件（写文件、rename、权限变更）。
 * 不去抖 → 一次保存刷新三遍 → 卡片闪三下。
 */
export function watchCardRoots(roots: CardRoot[], onChange: () => void): () => void {
  const watchers: FSWatcher[] = [];
  const pending = new Set<NodeJS.Timeout>();

  const fire = (): void => {
    // **去抖 200ms**：一次保存只刷新一遍
    const timer = setTimeout(() => {
      pending.delete(timer);
      onChange();
    }, 200);
    pending.add(timer);
  };

  const watchDir = (dir: string): void => {
    if (!existsSync(dir)) return;
    try {
      watchers.push(watch(dir, fire));
    } catch {
      // 目录没了 / 不许看 → 不监听（**不是错误**：目录本来就可能没有）
    }
  };

  for (const root of roots) {
    watchDir(root.dir);
    // 每个已装的卡片目录也各挂一个（卡片目录里改文件也算热更新）
    if (!existsSync(root.dir)) continue;
    for (const entry of readdirSync(root.dir, { withFileTypes: true })) {
      if (entry.isDirectory()) watchDir(join(root.dir, entry.name));
    }
  }

  return () => {
    for (const timer of pending) clearTimeout(timer);
    pending.clear();
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // 已经关了
      }
    }
  };
}

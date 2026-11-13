import { watch, type FSWatcher } from 'node:fs';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
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
  /** 已挂上的监听（按目录记——同一个目录不挂两次） */
  const watchers = new Map<string, FSWatcher>();
  const pending = new Set<NodeJS.Timeout>();

  const fire = (): void => {
    // **去抖 200ms**：一次保存只刷新一遍
    const timer = setTimeout(() => {
      pending.delete(timer);
      // **每次都重新挂一遍**：新装进来的卡目录这时才存在
      // （不重新挂 → 它的文件改了没人知道 →「改文件即生效」对它无效）
      ensureWatching();
      onChange();
    }, 200);
    pending.add(timer);
  };

  const watchDir = (dir: string): void => {
    if (watchers.has(dir)) return;
    if (!existsSync(dir)) return;
    try {
      watchers.set(dir, watch(dir, fire));
    } catch {
      // 目录没了 / 不许看 → 不监听（**不是错误**：目录本来就可能没有）
    }
  };

  /**
   * 把该监听的目录都挂上。
   *
   * ── 为什么每次变化后都要重来一遍 ──
   *
   * `fs.watch` **不递归** → 卡片目录**里面**的文件变了，根目录收不到事件。
   * 所以每个卡片目录都要各挂一个；而**启动之后才装进来的卡**，
   * 它的目录在启动时还不存在 → 只能在它出现之后（根目录的事件）再挂 ✓。
   */
  const ensureWatching = (): void => {
    for (const root of roots) {
      // **用户根目录：没有就建出来**
      //
      // 第一次跑应用时它还不存在 → 不建 → 不监听 →
      // 用户把卡放进去 → **应用永远不知道** → 卡片区永远是空的（除非重启）。
      // 而「卡片即文件」的第一步就是「有个地方放卡」——
      // 这个地方**应该由应用准备好**，不该让用户自己去建。
      //
      // **内置根不建**：那是应用安装目录，**只读**（装在 Program Files 里）。
      if (root.kind === 'user') {
        try {
          mkdirSync(root.dir, { recursive: true });
        } catch {
          // 建不了（权限）→ 不建，监听也挂不上（不是错误）
        }
      }
      watchDir(root.dir);
      if (!existsSync(root.dir)) continue;
      // 每个已装的卡片目录也各挂一个（卡片目录里改文件也算热更新）
      for (const entry of readdirSync(root.dir, { withFileTypes: true })) {
        if (entry.isDirectory()) watchDir(join(root.dir, entry.name));
      }
    }
  };

  ensureWatching();

  return () => {
    for (const timer of pending) clearTimeout(timer);
    pending.clear();
    for (const watcher of watchers.values()) {
      try {
        watcher.close();
      } catch {
        // 已经关了
      }
    }
    watchers.clear();
  };
}

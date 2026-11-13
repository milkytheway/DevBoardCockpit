import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 卡片目录的**内容指纹**。
 *
 * ── 它撑着什么 ──
 *
 * 契约 §八 与验收清单承诺：「改卡片里的一个字 → 不用重启，卡片就变了」
 * （「卡片即文件」是这个产品的核心主张）。
 *
 * **光刷新清单是不够的**：iframe 的 `src` 没变 → 浏览器**不重新加载** →
 * 卡片里跑的还是**旧代码**。清单刷新了、卡片没变 —— 用户看到的是「改了没反应」。
 *
 * → 所以「卡片内容变了」必须体现在**实例 id** 上：
 * 实例 id 变 → URL 变 → React 的 key 变 → **iframe 重建** → 新代码生效 ✓
 *
 * ── 为什么算**内容**哈希，不用 mtime ──
 *
 * 文件系统的时间戳粒度不一（有的地方只到 1 秒），
 * 「刚写完又改一次」可能落在**同一秒**里 → mtime 一样 → **不会重载**。
 * 卡片文件都很小，直接算内容哈希最稳。
 *
 * ── 跳过 `node_modules` / `.git` ──
 *
 * 它们很大，而且跟卡片代码无关（一个 `npm i` 不该让所有卡片重载）。
 */
const SKIP_DIRS = new Set(['node_modules', '.git']);

/**
 * 算一个卡片目录的内容指纹。
 *
 * @returns 同样的内容 → 同样的字符串；内容变了 → 不同的字符串
 */
export function cardRevision(dir: string): string {
  const hash = createHash('sha1');
  const files: string[] = [];

  const walk = (current: string, prefix: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      // 读不到（目录没了 / 没权限）→ 当它不存在
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(current, entry.name), `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = `${prefix}${entry.name}`;
      files.push(rel);
      hash.update(rel);
      try {
        hash.update(readFileSync(join(current, entry.name)));
      } catch {
        // 读不到内容 → 只算文件名（够用：内容变了文件名通常也变了）
      }
    }
  };

  walk(dir, '');
  // **文件顺序也要稳定**（readdir 的顺序不保证）
  files.sort();
  hash.update(files.join('\n'));
  return hash.digest('hex').slice(0, 12);
}

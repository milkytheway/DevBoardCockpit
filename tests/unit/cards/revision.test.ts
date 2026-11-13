import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cardRevision } from '../../../src/main/cards/revision';

/**
 * 卡片目录的**内容指纹**。
 *
 * ── 它是「改文件即热更新」的地基 ──
 *
 * 契约 §八 与验收清单都承诺「改卡片里的一个字 → 不用重启，卡片就变了」。
 * 而**光刷新清单不够**——iframe 的 URL 没变 → 浏览器不重新加载 →
 * 卡片里跑的还是**旧代码**。
 *
 * → 所以「卡片内容变了」必须体现在**实例 id** 上：
 * 实例 id 变 → URL 变 → React 的 key 变 → **iframe 重建** → 新代码生效。
 *
 * ── 为什么用**内容**哈希，不用 mtime ──
 *
 * 文件系统的时间戳粒度不一（有的地方是 1 秒），
 * 「刚写完又改一次」可能落在**同一秒**里 → mtime 一样 → 不会重载。
 * 卡片文件都很小，直接算内容哈希最稳。
 */
function scene(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'card-rev-'));
  writeFileSync(join(dir, 'index.html'), '<html></html>', 'utf8');
  writeFileSync(join(dir, 'card.js'), 'export const x = 1;', 'utf8');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('卡片目录的内容指纹', () => {
  it('**内容一样 → 指纹一样**（不能每次刷新都换 id，否则卡片永远在重载）', () => {
    const { dir, cleanup } = scene();
    try {
      expect(cardRevision(dir)).toBe(cardRevision(dir));
    } finally {
      cleanup();
    }
  });

  it('**内容变了 → 指纹变了**（这是热更新的触发点）', () => {
    const { dir, cleanup } = scene();
    try {
      const before = cardRevision(dir);
      writeFileSync(join(dir, 'card.js'), 'export const x = 2;', 'utf8');
      expect(cardRevision(dir)).not.toBe(before);
    } finally {
      cleanup();
    }
  });

  it('**同秒内改两次也要认出来**（mtime 靠不住，内容靠得住）', () => {
    const { dir, cleanup } = scene();
    try {
      const before = cardRevision(dir);
      writeFileSync(join(dir, 'card.js'), 'export const x = 2;', 'utf8');
      const middle = cardRevision(dir);
      writeFileSync(join(dir, 'card.js'), 'export const x = 3;', 'utf8');
      expect(middle).not.toBe(before);
      expect(cardRevision(dir)).not.toBe(middle);
    } finally {
      cleanup();
    }
  });

  it('**新增一个文件也算变了**', () => {
    const { dir, cleanup } = scene();
    try {
      const before = cardRevision(dir);
      writeFileSync(join(dir, 'style.css'), 'body{}', 'utf8');
      expect(cardRevision(dir)).not.toBe(before);
    } finally {
      cleanup();
    }
  });

  it('`node_modules` / `.git` **不算**（它们很大，而且跟卡片代码无关）', () => {
    const { dir, cleanup } = scene();
    try {
      const before = cardRevision(dir);
      mkdirSync(join(dir, 'node_modules'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'x.js'), 'x', 'utf8');
      mkdirSync(join(dir, '.git'), { recursive: true });
      writeFileSync(join(dir, '.git', 'HEAD'), 'ref', 'utf8');
      expect(cardRevision(dir)).toBe(before);
    } finally {
      cleanup();
    }
  });

  it('**子目录里的文件也算**（卡片的资源常常在子目录里）', () => {
    const { dir, cleanup } = scene();
    try {
      const before = cardRevision(dir);
      mkdirSync(join(dir, 'assets'), { recursive: true });
      writeFileSync(join(dir, 'assets', 'a.css'), 'a{}', 'utf8');
      expect(cardRevision(dir)).not.toBe(before);
    } finally {
      cleanup();
    }
  });
});

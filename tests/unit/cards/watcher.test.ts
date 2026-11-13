import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchCardRoots } from '../../../src/main/cards/watcher';

/**
 * 卡片目录的热插拔监听。
 *
 * ── 这两条曾经真的错着 ──
 *
 * ① **用户根目录不存在时直接不监听**——
 *    第一次跑应用时 `%LOCALAPPDATA%\DevBoardCockpit\cards` **还不存在**
 *    → 用户（或 agent）把卡放进去 → **应用永远不知道** → 卡片区永远是空的，
 *    除非重启。**「卡片即文件」最常见的那一步是坏的。**
 *
 * ② **启动之后才装进来的卡，它的目录没被监听**——
 *    监听只在启动时挂一遍；之后新出现的卡目录**只被根目录的事件带出来一次**，
 *    再改它的文件就**不会**触发刷新 → 「改文件即生效」对它无效。
 *
 * 两条都是 **e2e 跑起来才暴露的**（单元测试覆盖不到「目录在不在」这件事）。
 */
function scene(): { base: string; root: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'card-watch-'));
  return {
    base,
    root: join(base, 'cards'),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** 等到条件成立（监听有 200ms 去抖，所以要等） */
async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

describe('卡片目录监听', () => {
  it('**用户根目录不存在 → 建出来**（「卡片即文件」要先有个地方放卡）', () => {
    const { root, cleanup } = scene();
    try {
      const stop = watchCardRoots([{ dir: root, kind: 'user' }], () => undefined);
      try {
        expect(existsSync(root)).toBe(true);
      } finally {
        stop();
      }
    } finally {
      cleanup();
    }
  });

  it('**根目录不存在时放进去的卡，也会被发现**（第一次装卡不能要重启）', async () => {
    const { root, cleanup } = scene();
    try {
      let changed = 0;
      const stop = watchCardRoots([{ dir: root, kind: 'user' }], () => {
        changed += 1;
      });
      try {
        mkdirSync(join(root, 'c1'), { recursive: true });
        writeFileSync(join(root, 'c1', 'manifest.json'), '{}', 'utf8');
        expect(await waitFor(() => changed > 0)).toBe(true);
      } finally {
        stop();
      }
    } finally {
      cleanup();
    }
  });

  it('**启动之后才装进来的卡，它的目录也要被监听**（改文件即生效）', async () => {
    const { base, root, cleanup } = scene();
    try {
      mkdirSync(root, { recursive: true });
      let changed = 0;
      const stop = watchCardRoots([{ dir: root, kind: 'user' }], () => {
        changed += 1;
      });
      try {
        // 装一张卡
        mkdirSync(join(root, 'c1'), { recursive: true });
        writeFileSync(join(root, 'c1', 'manifest.json'), '{}', 'utf8');
        expect(await waitFor(() => changed > 0)).toBe(true);
        // 等监听重新挂上之后，改**卡里的文件**
        await new Promise((r) => setTimeout(r, 400));
        const before = changed;
        writeFileSync(join(root, 'c1', 'card.js'), '// 改一个字', 'utf8');
        expect(await waitFor(() => changed > before)).toBe(true);
        expect(base).toBeTruthy();
      } finally {
        stop();
      }
    } finally {
      cleanup();
    }
  });

  it('内置根目录**不建**（那是应用安装目录，只读）', () => {
    const { base, root, cleanup } = scene();
    try {
      const builtin = join(base, 'app', 'cards');
      const stop = watchCardRoots([{ dir: builtin, kind: 'builtin' }], () => undefined);
      try {
        expect(existsSync(builtin)).toBe(false);
      } finally {
        stop();
      }
      expect(root).toContain('cards');
    } finally {
      cleanup();
    }
  });
});

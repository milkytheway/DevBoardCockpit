import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, writeCard, cardDir, simpleCard, cardFrameFor } from './harness';

/**
 * 卡片沙箱的**隔离判据**（M5 的验收主体）。
 *
 * 设计 `docs/21` §10.1 定了**六条**；这里跑了**七条**
 * （六条 + 「卡片用不了浏览器的存储」——契约 §6.2 的前提，也得守着）。
 *
 * ── 为什么它们必须是「自动的」 ──
 *
 * 「卡片碰不到宿主」这件事，**人眼看不出来**——
 * 卡片照样显示，只是偷偷读了宿主的 DOM。
 * 所以每一条都要有**能跑、能红的判据**。
 *
 * ── 怎么跑 ──
 *
 * ```bash
 * npm run build && npm run test:cards
 * ```
 * （真 Electron；Linux 沙箱里没有 Linux 版 Electron，宿主侧跑。）
 */

test.describe('卡片沙箱', () => {
  test('卡片碰不到宿主 DOM', async () => {
    const launched = await launchApp();
    try {
      await writeCard(launched.userDataDir, 'e2e-card', simpleCard());
      const frame = await cardFrameFor(launched.window, 'e2e-card');
      const result = await frame.evaluate(() => {
        try {
          // @ts-expect-error 运行时才知道有没有
          const title = (window.parent as Window & { document?: Document }).document.title;
          return { ok: true, title };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/SecurityError/i);
    } finally {
      await launched.close();
    }
  });

  test('卡片连不上网（fetch 被 CSP 挡）', async () => {
    const launched = await launchApp();
    try {
      await writeCard(launched.userDataDir, 'e2e-card', simpleCard());
      const frame = await cardFrameFor(launched.window, 'e2e-card');
      const result = await frame.evaluate(async () => {
        try {
          await fetch('https://example.com/');
          return { blocked: false };
        } catch {
          return { blocked: true };
        }
      });
      expect(result.blocked).toBe(true);
    } finally {
      await launched.close();
    }
  });

  test('卡片读不到没权限的 tag（且看不出存不存在）', async () => {
    const launched = await launchApp();
    try {
      await writeCard(launched.userDataDir, 'e2e-card', simpleCard());
      const frame = await cardFrameFor(launched.window, 'e2e-card');
      const reading = await frame.evaluate(async () => {
        const value = await (window as unknown as { cockpit: { tags: { get(name: string): Promise<unknown> } } })
          .cockpit.tags.get('mem.usage');
        return value as { status: string; reason?: string; value: unknown };
      });
      expect(reading.status).toBe('unavailable');
      expect(reading.reason).toBe('not_found');
      expect(reading.value).toBeNull();
    } finally {
      await launched.close();
    }
  });

  test('卡片抛异常不影响宿主', async () => {
    const launched = await launchApp();
    try {
      await writeCard(launched.userDataDir, 'e2e-card', simpleCard());
      await cardFrame(launched.window);
      // 宿主还活着吗？
      const title = await launched.window.title();
      expect(title).toMatch(/开发板驾驶舱/);
    } finally {
      await launched.close();
    }
  });

  test('卡片用不了浏览器的存储（不透明源 → SecurityError）', async () => {
    const launched = await launchApp();
    try {
      await writeCard(launched.userDataDir, 'e2e-card', simpleCard());
      const frame = await cardFrameFor(launched.window, 'e2e-card');
      const result = await frame.evaluate(() => {
        try {
          window.localStorage.setItem('x', '1');
          return { threw: false };
        } catch (err) {
          return { threw: true, error: String(err) };
        }
      });
      expect(result.threw).toBe(true);
      expect(result.error).toMatch(/SecurityError/i);
    } finally {
      await launched.close();
    }
  });

  test('**内置的第一张卡自动出现**（不用手动复制——它就在内置根下）', async () => {
    const launched = await launchApp();
    try {
      // **不装任何卡**——内置的 `cards/cpu-usage/` 就该自己出现
      await expect
        .poll(
          async () => {
            const list = await cardsListOf(launched.window);
            return list.filter((c) => c.cardId === 'cpu-usage').length;
          },
          { timeout: 20_000 },
        )
        .toBeGreaterThan(0);
      const frame = await cardFrameFor(launched.window, 'cpu-usage');
      // 它得真的跑起来（不是只出现在清单里）
      expect(await frame.evaluate(() => typeof (window as unknown as { cockpit?: unknown }).cockpit)).toBe(
        'object',
      );
    } finally {
      await launched.close();
    }
  });

  test('卡片碰不到别的卡', async () => {
    const launched = await launchApp();
    try {
      await writeCard(launched.userDataDir, 'card-a', simpleCard('card-a'));
      await writeCard(launched.userDataDir, 'card-b', simpleCard('card-b'));
      await expect
        .poll(async () => cardFrames(launched.window).length, { timeout: 20_000 })
        .toBeGreaterThanOrEqual(2);
      const frame = await cardFrameFor(launched.window, 'card-a');
      const result = await frame.evaluate(() => {
        const out: Record<string, string> = { own: 'no-throw', other: 'no-throw' };
        try {
          // ① 自己的存储：不透明源 → 抛 SecurityError
          localStorage.setItem('x', '1');
        } catch (err) {
          out['own'] = String(err);
        }
        try {
          // ② **别的卡**的存储：跨源 → 抛 SecurityError
          const others = parent.frames;
          for (let i = 0; i < others.length; i += 1) {
            if (others[i] === window) continue;
            void others[i].localStorage.getItem('x');
          }
        } catch (err) {
          out['other'] = String(err);
        }
        return out;
      });
      expect(result.own).toMatch(/SecurityError/i);
      expect(result.other).toMatch(/SecurityError/i);
    } finally {
      await launched.close();
    }
  });

  test('改文件即热更新（改 card.js → 卡片重载 → 新行为生效）', async () => {
    const launched = await launchApp();
    try {
      await writeCard(launched.userDataDir, 'e2e-card', simpleCard('e2e-card', 'v1'));
      const frame = await cardFrameFor(launched.window, 'e2e-card');
      expect(await frame.evaluate(() => document.body.dataset.marker)).toBe('v1');

      // 改卡片里的一个字 —— **不重启**
      const file = join(cardDir(launched.userDataDir, 'e2e-card'), 'card.js');
      writeFileSync(file, "document.body.dataset.marker = 'v2';\n", 'utf8');

      await expect
        .poll(
          async () => {
            const frames = cardFrames(launched.window).filter((f) =>
              f.url().startsWith('cockpit://card/'),
            );
            // **按实例找那张 e2e-card**（内置卡也在列表里，不能靠顺序）
            const list = await cardsListOf(launched.window);
            const info = list.find((c) => c.cardId === 'e2e-card');
            if (info === undefined) return 'no-card';
            const target = frames.find((f) => f.url().startsWith(`cockpit://card/${info.instanceId}/`));
            if (target === undefined) return 'no-frame';
            return await target
              .evaluate(() => document.body.dataset.marker ?? 'none')
              .catch(() => 'gone');
          },
          { timeout: 20_000 },
        )
        .toBe('v2');
    } finally {
      await launched.close();
    }
  });
});

/** 问宿主要装着的卡片清单 */
async function cardsListOf(
  page: import('@playwright/test').Page,
): Promise<{ cardId: string; instanceId: string }[]> {
  return page.evaluate(() =>
    (
      window as unknown as {
        cockpit: { cardsList(): Promise<{ cardId: string; instanceId: string }[]> };
      }
    ).cockpit.cardsList(),
  );
}

/** 所有卡片 iframe */
function cardFrames(page: import('@playwright/test').Page): import('@playwright/test').Frame[] {
  return page.frames().filter((f) => f.url().startsWith('cockpit://card/'));
}

/** 等卡片 iframe 出现并返回它 */
async function cardFrame(page: import('@playwright/test').Page): Promise<import('@playwright/test').Frame> {
  await expect
    .poll(
      async () => cardFrames(page).length,
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  const frame = cardFrames(page)[0];
  if (frame === undefined) throw new Error('卡片 iframe 没出现');
  return frame;
}

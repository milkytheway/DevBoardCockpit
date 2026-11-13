import { test, expect } from '@playwright/test';
import { launchApp, writeCard, simpleCard } from './harness';

/**
 * 卡片沙箱的**十条隔离判据**（M5 的验收主体）。
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
      const frame = await cardFrame(launched.window);
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
      const frame = await cardFrame(launched.window);
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
      const frame = await cardFrame(launched.window);
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
      const frame = await cardFrame(launched.window);
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
});

/** 等卡片 iframe 出现并返回它 */
async function cardFrame(page: import('@playwright/test').Page): Promise<import('@playwright/test').Frame> {
  await expect
    .poll(
      async () => {
        const frames = page.frames().filter((f) => f.url().startsWith('cockpit://card/'));
        return frames.length;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  const frame = page.frames().find((f) => f.url().startsWith('cockpit://card/'));
  if (frame === undefined) throw new Error('卡片 iframe 没出现');
  return frame;
}

import { test, expect } from '@playwright/test';
import { launchApp } from './harness';

/**
 * 外壳自检：应用**起得来**、preload **加载了**。
 *
 * ── 为什么先测这个 ──
 *
 * 后面十条隔离判据全都在这个应用里跑。
 * 应用起不来，十条判据全是「红」——但那是**环境红**，不是**判据红**。
 * 先把地基验掉，后面的红才红得可信。
 */
test('应用起得来，preload 装上了宿主能力', async () => {
  const launched = await launchApp();
  try {
    await expect(launched.window).toHaveTitle(/开发板驾驶舱/);

    // preload 的白名单 API 在页面里
    const apiKeys = await launched.window.evaluate(() =>
      Object.keys((window as unknown as { cockpit: Record<string, unknown> }).cockpit ?? {}).sort(),
    );
    expect(apiKeys.length).toBeGreaterThan(0);
    expect(apiKeys).toContain('tagsReadings');
  } finally {
    await launched.close();
  }
});

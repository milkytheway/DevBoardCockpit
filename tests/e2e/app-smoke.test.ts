import { test, expect } from '@playwright/test';
import { launchApp } from './harness';

/**
 * The self-check of the shell: the application **starts** and the preload
 * **loaded**.
 *
 * ── Why this comes first ──
 *
 * The ten isolation judgments that follow all run in this application. If the
 * application does not start, all ten are red — but that is an **environment
 * red**, not a **judgment red**. Once the ground is verified, the later reds
 * can be trusted.
 */
test('the application starts and the preload installs the host capabilities', async () => {
  const launched = await launchApp();
  try {
    await expect(launched.window).toHaveTitle(/DevBoard Cockpit/);

    // The whitelisted API of the preload is in the page
    const apiKeys = await launched.window.evaluate(() =>
      Object.keys((window as unknown as { cockpit: Record<string, unknown> }).cockpit ?? {}).sort(),
    );
    expect(apiKeys.length).toBeGreaterThan(0);
    expect(apiKeys).toContain('tagsReadings');
  } finally {
    await launched.close();
  }
});

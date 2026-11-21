import { test, expect } from '@playwright/test';
import { launchApp } from './harness';

/**
 * The smoke test of the wizard page in a real Electron.
 *
 * ── Why this one exists (the judgments of the web layer do not reach it) ──
 *
 * → `tests/web/wizard-page.test.tsx` tests the **component** (with a fake
 *   `run`).
 * → It cannot reach two things:
 *   ① the **real call into the host** (whether the `wizardRun` channel
 *      works);
 *   ② the **chain on the real board** (whether a serial port or ADB really
 *      probes a pack out of the board).
 * → This one goes through a **real Electron** (a real main, a real preload, a
 *   real board).
 *
 * The application starts in the Chinese locale (`zh-Hans`), so the wording
 * the assertions look for is the wording of that locale.
 */
test('The wizard page · it runs in a real Electron', async () => {
  const { window, close } = await launchApp();
  try {
    // ── ① the board dialog opens from the board selector ──
    await window.getByRole('button', { name: /板子/ }).click();
    await window.getByRole('button', { name: '添加开发板' }).click();
    await window.waitForTimeout(400);
    await window.getByRole('dialog', { name: '添加开发板' }).waitFor();
    expect(await window.locator('.wizard-form').count()).toBeGreaterThan(0);

    // ── ② the real board · ADB → the successful state ──
    await window.getByRole('button', { name: 'ADB' }).click();
    await window.getByLabel('板子名字').fill('e2e test board');
    await window.getByRole('button', { name: '开始接板' }).click();

    // One call into the host runs the whole chain → **wait for the result**
    // (not for a fixed number of seconds)
    await window.locator('.wizard-result__title').waitFor({ timeout: 60000 });
    const title = await window.locator('.wizard-result__title').textContent();
    expect(title, 'the real board · ADB → success').toBe('开发板已添加');

    // The sentence about the first version may not be hidden
    expect(await window.locator('.wizard-result').textContent()).toContain('初版包');

    // ── ③ a serial port that does not open → it says it in plain words and does not crash ──
    await window.getByRole('button', { name: '改参数' }).click();
    await window.getByRole('button', { name: '串口' }).click();
    await window.getByLabel('串口').fill('COM99');
    await window.getByLabel('板子名字').fill('e2e failing board');
    await window.getByRole('button', { name: '开始接板' }).click();
    await window.locator('.wizard-result__title').waitFor({ timeout: 60000 });
    const failTitle = await window.locator('.wizard-result__title').textContent();
    expect(failTitle, 'a failure is reported in plain words').toBe('板子没说话');
    // It may not say "the connection failed"
    expect(await window.locator('.wizard-result').textContent()).not.toContain(
      'the connection failed',
    );
  } finally {
    await close();
  }
});

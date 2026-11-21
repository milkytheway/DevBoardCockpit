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
 *   ② the **chain** (whether a serial port or ADB really probes a pack out of
 *      the board).
 * → This one goes through a **real Electron** (a real main, a real preload, a
 *   real board).
 *
 * ── What the criterion is (and what it is not) ──
 *
 * → **The outcome depends on the machine** ✓: a machine with adb and a board
 *   plugged in adds the board ✓ · a machine without adb reports the failure
 *   ✓. So the criterion is **not** "the board was added" ✗ — that one needs
 *   hardware ✗, and a criterion that needs hardware is **red on the build
 *   machine** ✗ (found on 2026-11-22 ✗: the CI runner has no adb ✗ and the
 *   test was red there ✗).
 * → The criterion is the **honest report** ✓: the chain runs ✓ and the title
 *   is one of the outcomes that can really happen over ADB ✓.
 * → **"The serial port cannot be opened" is not one of them** ✓ — the ADB
 *   line has no serial port ✓ → saying it is a lie ✓ (the wizard used to say
 *   exactly that ✗ · found on 2026-11-22 ✓).
 * → The hardware case (a board that is really added ✓) belongs to the
 *   acceptance run with a board ✓ (`scripts/acceptance/` ✓).
 *
 * The application starts in the Chinese locale (`zh-Hans`), so the wording
 * the assertions look for is the wording of that locale.
 */

/** The outcomes that the wizard over ADB can really produce ✓ */
const HONEST_OUTCOMES = ['开发板已添加', '连接失败', '开发板无响应', '连接未建立'];

test('The wizard page · it runs in a real Electron', async () => {
  const { window, close } = await launchApp();
  try {
    // ── ① the board dialog opens from the board selector ──
    await window.getByRole('button', { name: /板子/ }).click();
    await window.getByRole('button', { name: '添加开发板' }).click();
    await window.waitForTimeout(400);
    await window.getByRole('dialog', { name: '添加开发板' }).waitFor();
    expect(await window.locator('.wizard-form').count()).toBeGreaterThan(0);

    // ── ② the chain runs over ADB ──
    await window.getByRole('button', { name: 'ADB' }).click();
    await window.getByRole('button', { name: '建立连接' }).click();

    // One call into the host runs the whole chain → **wait for the result**
    // (not for a fixed number of seconds)
    await window.locator('.wizard-result__title').waitFor({ timeout: 60000 });
    const title = ((await window.locator('.wizard-result__title').textContent()) ?? '').trim();

    expect(
      HONEST_OUTCOMES,
      `the wizard reported "${title}" — over ADB it may not talk about a serial port`,
    ).toContain(title);

    if (title === '开发板已添加') {
      // → **This machine has a board over ADB** ✓ → the initial configuration
      //   is shown ✓
      expect(await window.locator('.wizard-result').textContent()).toContain('初始配置');
    }
  } finally {
    await close();
  }
});

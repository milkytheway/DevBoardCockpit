import { test, expect } from '@playwright/test';
import { launchApp } from './harness';

/**
 * The files page: **it does not need an open terminal** ✓.
 *
 * → The page used to ask the terminal for a session ✓ → it was empty until
 *   the user opened a terminal ✗.
 * → Now **the host picks the link** ✓ (ADB → SSH → serial ✓) and the page
 *   uses it ✓.
 * → The judgment runs against the **fake device** ✓ (it always answers ✓)
 *   → no hardware ✓ and it runs in CI ✓.
 */
test('the files page works without an open terminal (the host picks the link)', async () => {
  const launched = await launchApp({ env: { COCKPIT_FAKE: 'only' } });
  try {
    // → The files page ✓ (the stable hook ✓ — not the wording ✓).
    await launched.window.locator('[data-cockpit-page="files"]').click();

    // → **No terminal was opened** ✓ → the page must not be empty ✓.
    await expect(launched.window.locator('.page-empty')).toHaveCount(0);
    await expect(launched.window.locator('.files-stage')).toBeVisible();

    // → The page says **which link** it uses ✓ (the host picked it ✓) →
    //   and the judgment reads the link from the host ✓ → it does not
    //   hard-code a transport ✓ (the fake board is an ssh one ✓).
    const endpoint = await launched.window.evaluate(() =>
      (window as unknown as { cockpit: { filesEndpoint(): Promise<{ transport: string }> } })
        .cockpit.filesEndpoint(),
    );
    await expect(launched.window.locator('.page-head__sub')).toContainText(endpoint.transport);
  } finally {
    await launched.close();
  }
});

/**
 * The link is **the host's business** ✓ — the page never picks one itself ✓.
 *
 * → The sidebar says which link is in use ✓ (a transfer that goes somewhere
 *   else is a surprise ✓).
 */
test('the sidebar names the link the host picked', async () => {
  const launched = await launchApp({ env: { COCKPIT_FAKE: 'only' } });
  try {
    await launched.window.locator('[data-cockpit-page="files"]').click();
    await expect(launched.window.locator('.secondary__group').first()).toBeVisible();

    // → The label of the link comes from the host ✓ → the judgment does not
    //   depend on the language of the interface ✓.
    const endpoint = await launched.window.evaluate(() =>
      (window as unknown as { cockpit: { filesEndpoint(): Promise<{ label: string }> } })
        .cockpit.filesEndpoint(),
    );
    await expect(launched.window.locator('.secondary__label').first()).toHaveText(
      endpoint.label,
    );
  } finally {
    await launched.close();
  }
});

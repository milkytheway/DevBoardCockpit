import { test, expect } from '@playwright/test';
import { launchApp, writeCard, simpleCard, cardsList } from './harness';

/**
 * **Switching the board keeps the cards in the work area.**
 *
 * → A card is bound to `(cardId, connectionId)` ✓ → the instances of the new
 *   board carry the **new** connection id ✓ → the cells of the work area have
 *   to follow ✓ → **otherwise the cards disappear** ✓ (found on 2026-11-21 ✓).
 * → The fake device plays **two boards** ✓ (`COCKPIT_FAKE_PROFILES` ✓) → the
 *   judgment needs no hardware ✓.
 */
test('switching the board keeps the cards in the work area', async () => {
  const launched = await launchApp({
    env: { COCKPIT_FAKE: 'only', COCKPIT_FAKE_PROFILES: 'fake-board,fake-target' },
  });
  try {
    // → A card of its own ✓ (the built-in ones would do ✓ but one of our own
    //   is easier to count ✓).
    await writeCard(launched.userDataDir, 'e2e-card', simpleCard('e2e-card'));
    await launched.window.locator('[data-cockpit-page="workbench"]').click();

    // → Place it in the work area ✓ (the catalogue is in the sidebar ✓).
    const card = launched.window.locator('[data-cockpit-card-id="e2e-card"]').first();
    await expect(card).toBeVisible();
    await card.click();

    // → It is there ✓ (a card that is placed has an instance ✓).
    await expect
      .poll(async () => (await cardsList(launched.window)).length, { timeout: 20_000 })
      .toBeGreaterThan(0);
    const before = await launched.window.locator('iframe[src^="cockpit://card/"]').count();
    expect(before).toBeGreaterThan(0);

    // → **Switch to the other board** ✓ (the picker at the top ✓).
    await launched.window.locator('.device-picker__trigger').click();
    const target = launched.window.locator('[data-cockpit-board="fake-target"]').first();
    await expect(target).toBeVisible();
    await target.click();

    // → The card is **still in the work area** ✓ (the cells followed the board ✓).
    await expect
      .poll(
        async () => launched.window.locator('iframe[src^="cockpit://card/"]').count(),
        { timeout: 20_000 },
      )
      .toBe(before);
  } finally {
    await launched.close();
  }
});

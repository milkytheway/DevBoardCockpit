import { test, expect } from '@playwright/test';
import { launchApp } from './harness';

/**
 * The terminal: **a connection that is opened is a terminal that is there**.
 *
 * ── Why this judgment is an end-to-end one ──
 *
 * → The unit tests judge the pieces ✓ (the profile ✓ · the credential ✓ ·
 *   the scope ✓) → but the defect the user reported was **"clicking the
 *   terminal does nothing"** ✓ → and that is a defect of the **chain** ✓:
 *   the click ✓ → the session on the host ✓ → the session on the page ✓.
 * → A chain has no unit ✓ → it has an end-to-end judgment ✓.
 *
 * ── The fake board is the board here ✓ ──
 *
 * → The fake device answers ✓ (it always does ✓) → the judgment does not
 *   need a real board ✓ → **it runs in CI** ✓.
 * → It is also the board whose isolation is at stake ✓ (the synthetic data
 *   must not take a real board's role ✓).
 */
test('the terminal of a connection comes up — the session is on the page', async () => {
  const launched = await launchApp({ env: { COCKPIT_FAKE: 'only' } });
  try {
    // → The terminal page ✓ (the stable hook ✓ — not the wording ✓).
    await launched.window.locator('[data-cockpit-page="terminal"]').click();

    // → **The connections of the board that is current** ✓ are listed ✓.
    const connection = launched.window
      .locator('.secondary__item', { hasText: 'fake board' })
      .first();
    await expect(connection).toBeVisible();

    // → The empty state is there before the click ✓ (the judgment knows what
    //   it is looking for ✓).
    await expect(launched.window.locator('.page-empty')).toHaveCount(1);

    // → Click it ✓ → the session opens on the host ✓ → **the terminal page
    //   shows it** ✓ (this is what was broken ✓ — the session was opened and
    //   the page stayed empty ✓).
    await connection.click();

    await expect(launched.window.locator('[data-testid^="terminal-pane-"]')).toHaveCount(1);
    await expect(launched.window.locator('.page-empty')).toHaveCount(0);
    // → The tab says **which** connection it is ✓ (the user has to know whose
    //   terminal they are looking at ✓).
    await expect(launched.window.locator('.terminal__tab-label')).toHaveText(/fake board/);
  } finally {
    await launched.close();
  }
});

/**
 * **No group without rows is drawn** ✓.
 *
 * → The sidebar used to draw a group for **every** board ✓ — and the group
 *   of a board that has no session was **empty** ✓ → it looked like a board
 *   that is there but has nothing ✗ (the screenshot of 2026-11-21 ✓).
 * → **Two fake boards** ✓ (the fake device can play several roles ✓) → the
 *   judgment has a board that is **not** the current one ✓ → without the rule
 *   its group would be drawn empty ✓.
 * → **No hardware is touched** ✓ (the fake device only ✓).
 */
test('the terminal page draws no group without rows', async () => {
  const launched = await launchApp({
    env: { COCKPIT_FAKE: 'only', COCKPIT_FAKE_PROFILES: 'fake-board,fake-target' },
  });
  try {
    await launched.window.locator('[data-cockpit-page="terminal"]').click();
    // → Wait for the sidebar to be there ✓ (it is filled by the host ✓).
    await expect(launched.window.locator('.secondary__group').first()).toBeVisible();

    const emptyGroups = await launched.window.evaluate(() =>
      [...document.querySelectorAll('.secondary__group')]
        .filter((group) => group.querySelectorAll('.secondary__item').length === 0)
        .map((group) => group.querySelector('.secondary__title span')?.textContent ?? ''),
    );
    expect(emptyGroups).toEqual([]);
  } finally {
    await launched.close();
  }
});

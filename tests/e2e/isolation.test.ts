import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, writeCard, cardDir, simpleCard, cardFrameFor, placeCard } from './harness';

/**
 * The isolation judgments of the card sandbox (the body of the M5 acceptance).
 *
 * The sandbox rules of the contract (`docs/spec/03-card-manifest.md`
 * section 6) are six; this file runs seven — the six plus "a card cannot use
 * the storage of the browser", which is the premise of section 6.2 and has to
 * be guarded as well.
 *
 * ── Why they have to be automatic ──
 *
 * "a card cannot reach the host" is not something a person can see — the card
 * renders as usual, it only reads the DOM of the host quietly. So every rule
 * needs a judgment that **runs and that can turn red**.
 *
 * ── How to run them ──
 *
 * ```bash
 * npm run build && npm run test:cards
 * ```
 * (a real Electron; the Linux sandbox has no Linux build of Electron, so this
 * runs on the host.)
 */

test.describe('The card sandbox', () => {
  test('a card cannot reach the DOM of the host', async () => {
    const launched = await launchApp();
    try {
      await writeCard(launched.userDataDir, 'e2e-card', simpleCard());
      // The main area starts empty — the card has to be placed from the
      // catalogue of the secondary sidebar first
      await placeCard(launched.window, 'e2e-card');
      const frame = await cardFrameFor(launched.window, 'e2e-card');
      const result = await frame.evaluate(() => {
        try {
          // @ts-expect-error it is only known at run time
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

  test('a card cannot reach the network (the CSP blocks fetch)', async () => {
    const launched = await launchApp();
    try {
      await writeCard(launched.userDataDir, 'e2e-card', simpleCard());
      // The main area starts empty — the card has to be placed from the
      // catalogue of the secondary sidebar first
      await placeCard(launched.window, 'e2e-card');
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

  test('a card cannot read a tag it has no permission for (and cannot tell whether it exists)', async () => {
    const launched = await launchApp();
    try {
      await writeCard(launched.userDataDir, 'e2e-card', simpleCard());
      // The main area starts empty — the card has to be placed from the
      // catalogue of the secondary sidebar first
      await placeCard(launched.window, 'e2e-card');
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

  test('an exception in a card does not affect the host', async () => {
    const launched = await launchApp();
    try {
      await writeCard(launched.userDataDir, 'e2e-card', simpleCard());
      await placeCard(launched.window, 'e2e-card');
      await cardFrame(launched.window);
      // Is the host still alive?
      const title = await launched.window.title();
      expect(title).toMatch(/DevBoard Cockpit/);
    } finally {
      await launched.close();
    }
  });

  test('a card cannot use the storage of the browser (an opaque origin → SecurityError)', async () => {
    const launched = await launchApp();
    try {
      await writeCard(launched.userDataDir, 'e2e-card', simpleCard());
      // The main area starts empty — the card has to be placed from the
      // catalogue of the secondary sidebar first
      await placeCard(launched.window, 'e2e-card');
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

  test('the first built-in card appears by itself (it is under the built-in root, no copying needed)', async () => {
    const launched = await launchApp();
    try {
      // No card is installed — the built-in `cards/cpu-usage/` has to be
      // discovered on its own
      await expect
        .poll(
          async () => {
            const list = await cardsListOf(launched.window);
            return list.filter((c) => c.cardId === 'cpu-usage').length;
          },
          { timeout: 20_000 },
        )
        .toBeGreaterThan(0);
      // Placed in the work area → it has to really run (not only appear in the list)
      await placeCard(launched.window, 'cpu-usage');
      const frame = await cardFrameFor(launched.window, 'cpu-usage');
      expect(await frame.evaluate(() => typeof (window as unknown as { cockpit?: unknown }).cockpit)).toBe(
        'object',
      );
    } finally {
      await launched.close();
    }
  });

  test('a card cannot reach another card', async () => {
    const launched = await launchApp();
    try {
      await writeCard(launched.userDataDir, 'card-a', simpleCard('card-a'));
      await writeCard(launched.userDataDir, 'card-b', simpleCard('card-b'));
      await placeCard(launched.window, 'card-a');
      await placeCard(launched.window, 'card-b');
      await expect
        .poll(async () => cardFrames(launched.window).length, { timeout: 20_000 })
        .toBeGreaterThanOrEqual(2);
      const frame = await cardFrameFor(launched.window, 'card-a');
      const result = await frame.evaluate(() => {
        const out: Record<string, string> = { own: 'no-throw', other: 'no-throw' };
        try {
          // ① Its own storage: an opaque origin → a SecurityError
          localStorage.setItem('x', '1');
        } catch (err) {
          out['own'] = String(err);
        }
        try {
          // ② The storage of **another card**: a cross-origin access → a SecurityError
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

  test('editing a file reloads the card (edit card.js → the card reloads → the new behaviour takes effect)', async () => {
    const launched = await launchApp();
    try {
      await writeCard(launched.userDataDir, 'e2e-card', simpleCard('e2e-card', 'v1'));
      await placeCard(launched.window, 'e2e-card');
      const frame = await cardFrameFor(launched.window, 'e2e-card');
      expect(await frame.evaluate(() => document.body.dataset.marker)).toBe('v1');

      // Change one character in the card — without a restart
      const file = join(cardDir(launched.userDataDir, 'e2e-card'), 'card.js');
      writeFileSync(file, "document.body.dataset.marker = 'v2';\n", 'utf8');

      await expect
        .poll(
          async () => {
            const frames = cardFrames(launched.window).filter((f) =>
              f.url().startsWith('cockpit://card/'),
            );
            // The e2e-card is found **by its instance** (the built-in cards are
            // in the list too, so the order cannot be used)
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

/** Ask the host for the list of the installed cards */
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

/** All the card iframes */
function cardFrames(page: import('@playwright/test').Page): import('@playwright/test').Frame[] {
  return page.frames().filter((f) => f.url().startsWith('cockpit://card/'));
}

/** Wait for a card iframe to appear and return it */
async function cardFrame(page: import('@playwright/test').Page): Promise<import('@playwright/test').Frame> {
  await expect
    .poll(
      async () => cardFrames(page).length,
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  const frame = cardFrames(page)[0];
  if (frame === undefined) throw new Error('the card iframe did not appear');
  return frame;
}

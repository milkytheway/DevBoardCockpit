import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, writeCard, simpleCard, cardFrameFor, placeCard } from './harness';

/**
 * The layout: **after the drag the position is still there** (the acceptance
 * judgment of M5b).
 *
 * ── Why a restart of the application is needed for this to count ──
 *
 * A position that only lives in **memory** does not count — the user closes
 * the application. The contract says a layout unit records
 * `(cardId, connectionId)`, and it is written to the `layout.json` of the
 * **user data directory** (the ledger of the host).
 *
 * → So the judgment is: **drag → close the application → open it again → the
 *   position is still there**.
 */
test('dragging a card → the position is remembered (it survives a restart)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-layout-e2e-'));
  try {
    // ── The first run: install the card, drag it, note the position ──
    const first = await launchApp({ userDataDir: root });
    let moved: { x: number; y: number } | null = null;
    try {
      await writeCard(first.userDataDir, 'e2e-card', simpleCard('e2e-card'));
      await placeCard(first.window, 'e2e-card');
      await cardFrameFor(first.window, 'e2e-card');

      // The handle is chosen by its stable hook (`data-cockpit-drag-handle`) —
      // not by a class name: when the shell is reskinned or a class is renamed,
      // this judgment must not break
      const handle = first.window.locator(
        '[data-cockpit-drag-handle="true"][data-card-id="e2e-card"]',
      );
      await expect(handle).toBeVisible();
      const box = await handle.boundingBox();
      if (box === null) throw new Error('the drag handle has no position');

      // The drag: press → move → release
      await first.window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await first.window.mouse.down();
      await first.window.mouse.move(box.x + box.width / 2 + 260, box.y + box.height / 2 + 120, {
        steps: 12,
      });
      await first.window.mouse.up();

      // Did the position change?
      await expect
        .poll(
          async () => {
            const units = await first.window.evaluate(() =>
              (
                window as unknown as {
                  cockpit: {
                    layoutGet(): Promise<{ units: { cardId: string; x: number; y: number }[] }>;
                  };
                }
              ).cockpit.layoutGet(),
            );
            const unit = units.units.find((u) => u.cardId === 'e2e-card');
            return unit === undefined ? null : { x: unit.x, y: unit.y };
          },
          { timeout: 15_000 },
        )
        .not.toEqual({ x: 0, y: 0 });
      moved = await first.window.evaluate(() =>
        (
          window as unknown as {
            cockpit: {
              layoutGet(): Promise<{ units: { cardId: string; x: number; y: number }[] }>;
            };
          }
        )
          .cockpit.layoutGet()
          .then((s) => {
            const unit = s.units.find((u) => u.cardId === 'e2e-card');
            return unit === undefined ? null : { x: unit.x, y: unit.y };
          }),
      );
    } finally {
      await first.close();
    }
    expect(moved).not.toBeNull();

    // ── The second run: open it again with the **same user directory** → the position is still there ──
    const second = await launchApp({ userDataDir: root });
    try {
      await writeCard(second.userDataDir, 'e2e-card', simpleCard('e2e-card'));
      await cardFrameFor(second.window, 'e2e-card');
      const units = await second.window.evaluate(() =>
        (
          window as unknown as {
            cockpit: {
              layoutGet(): Promise<{ units: { cardId: string; x: number; y: number }[] }>;
            };
          }
        ).cockpit.layoutGet(),
      );
      const unit = units.units.find((u) => u.cardId === 'e2e-card');
      expect(unit).toBeDefined();
      expect({ x: unit?.x, y: unit?.y }).toEqual(moved);
    } finally {
      await second.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

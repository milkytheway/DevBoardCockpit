import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, writeCard, currentCardFrame, placeCard, APP_NAME } from './harness';

/**
 * The write side, end to end: a card triggers an action → the interface
 * renders the **readback value**.
 *
 * ── What this judgment proves ──
 *
 * The contract (`docs/spec/03-card-manifest.md` section 5.2):
 *
 * > "A card must render the value that came back; it may not update
 * > optimistically on its own."
 *
 * → So the judgment is not "the action ran", but:
 * **the number the card shows was read back from the board**.
 * With an optimistic update the card would show the parameter it just sent,
 * and the card would also show "set to 200" while the board is not connected.
 *
 * ── Why the fake device ──
 *
 * The real board is not on this machine, and this judgment has to be
 * **automatable**. The fake device now has a **virtual disk**
 * (`hal/fake/fs.ts`) → the command of the action is really written and the
 * readback is really read.
 *
 * ── All three layers have to be real ──
 *
 * ① **The main side**: the authorisation ledger → the permission decision →
 *   the executor → the readback → the audit (the real code)
 * ② **The HAL side**: the virtual disk of the fake device (a real file
 *   round trip)
 * ③ **The card side**: the JavaScript in the card iframe really renders the
 *   value that came back
 */

/** A card that calls an action (it renders the readback value, not the parameter it sent) */
const ACTION_CARD: Record<string, string> = {
  'manifest.json': JSON.stringify(
    {
      apiVersion: 'devboard/v1',
      kind: 'Card',
      id: 'action-card',
      name: 'Action card',
      version: '1.0.0',
      entry: 'index.html',
      requires: { actions: ['backlight.set'] },
      permissions: { read: [], write: ['backlight.set'] },
    },
    null,
    2,
  ),
  'index.html':
    '<!doctype html><meta charset="utf-8"><body><div id="result">pending</div>' +
    '<script type="module" src="./card.js"></script>',
  'card.js': [
    "const el = document.getElementById('result');",
    "cockpit.actions.invoke('backlight.set', { value: 200 })",
    '  .then((r) => {',
    '    el.textContent = JSON.stringify({',
    '      ok: r.ok,',
    '      verified: r.verified,',
    "      value: r.readback ? r.readback.value : null,",
    '      audit: r.audit_id ?? null,',
    '    });',
    '  })',
    "  .catch((e) => { el.textContent = 'error:' + String(e); });",
  ].join('\n'),
};

test('a card triggers an action → the interface renders the readback value (not an optimistic update)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-action-e2e-'));
  try {
    /**
     * ── The permission has to be opened first ──
     *
     * → A card may not write to a board by default (ADR-D47 — the unified
     *   permission area of the settings page)
     *   → The reason: the host **cannot verify that a person pressed the
     *   button on the card** → the default is no → the person who wants to
     *   write to the board opens it in the settings
     * → This ledger is what the switch of the settings page stored
     *   (`permissions.json`)
     */
    const userDataDir = join(root, APP_NAME);
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(
      join(userDataDir, 'permissions.json'),
      JSON.stringify({ card: { 'action:backlight.set': true }, agent: {} }, null, 2),
      'utf8',
    );

    // The fake device only (the real board is not on this machine)
    const app = await launchApp({ userDataDir: root, env: { COCKPIT_FAKE: 'only' } });
    try {
      /**
       * ── There is no fake device in the production build ──
       *
       * ADR-D30: the fake device **is not in the production package** (that is
       * what `scripts/check-build.ts` verifies) → this judgment only runs
       * with `npm run build:fake` (`--mode fake`).
       *
       * → **It decides for itself**: is the fake profile in the list of the
       *   connections?
       * → If it is not, it **skips and says why** (rather than passing
       *   quietly).
       */
      const hasFake = await app.window.evaluate(async () => {
        const list = await (
          window as unknown as {
            cockpit: { connectionsList(): Promise<{ id: string }[]> };
          }
        ).cockpit.connectionsList();
        return list.some((c) => c.id === 'fake-board');
      });
      test.skip(
        !hasFake,
        'this judgment needs a build that carries the fake device (npm run build:fake) — the production build has no fake device (ADR-D30)',
      );

      // ── Wait for the runtime to connect (the action runs on that connection) ──
      await expect
        .poll(
          async () =>
            app.window.evaluate(() =>
              (
                window as unknown as { cockpit: { tagsReadings(): Promise<unknown[]> } }
              ).cockpit.tagsReadings(),
            ),
          { timeout: 20_000 },
        )
        .not.toHaveLength(0);

      await writeCard(app.userDataDir, 'action-card', ACTION_CARD);
      // The card goes into the workbench first (the rule of the shell: a card
      // has to be in place before it enters the main area)
      await placeCard(app.window, 'action-card');

      /**
       * ── Wait for the rendering of the **successful** run ──
       *
       * A card that was just written is hot reloaded once (the content
       * fingerprint changed → the instance id changed → the iframe was
       * rebuilt) → the script of the card runs **twice**: the first run may
       * come before the runtime is connected (it fails), the second one is the
       * one that succeeds.
       *
       * → So it must **not** wait for `"ok"` to appear — that would catch the
       *   first run, the failing one.
       * → It waits for the **readback value 200** (only the success has it).
       */
      await expect
        .poll(
          async () => {
            // The frame is looked up again on every round (the hot reload
            // replaces the old frame)
            const frame = await currentCardFrame(app.window, 'action-card');
            if (frame === undefined) return '';
            return (await frame.locator('#result').textContent().catch(() => '')) ?? '';
          },
          { timeout: 30_000 },
        )
        .toContain('"value":"200"');

      const frame = await currentCardFrame(app.window, 'action-card');
      if (frame === undefined) throw new Error('the iframe of the card action-card is gone');
      const raw = (await frame.locator('#result').textContent()) ?? '{}';
      const rendered = JSON.parse(raw) as {
        ok: boolean;
        verified: boolean;
        value: string | null;
        audit: string | null;
        reason?: string;
      };
      // When it fails, what the card saw is carried out as it is (otherwise
      // only "not true" is left)
      expect(rendered.ok, `the result the card saw: ${raw}`).toBe(true);
      expect(rendered.verified).toBe(true);
      // The value that was read back (the board really holds 200) — not the
      // parameter the card sent
      expect(rendered.value).toBe('200');
      // The result carries the id of the audit (contract `docs/spec/04-mcp-tools.md` section 2.4)
      expect(rendered.audit).toBeTruthy();

      // ── The audit: exactly one line, and it holds the parameter and the readback value ──
      const auditPath = join(app.userDataDir, 'logs', 'actions.log');
      expect(existsSync(auditPath)).toBe(true);
      const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('action=backlight.set');
      // The readback value is **text** (file_equals compares the content of
      // the file) → the audit line holds it in quotes
      expect(lines[0]).toContain('value="200"');
      expect(lines[0]).toContain('verified=true');
    } finally {
      await app.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * By default a card may not write to the board (ADR-D47, C2).
 *
 * → The host **cannot verify that a person pressed the button on the card** →
 *   the default is no
 * → The person who wants to write to the board opens that switch in the
 *   settings (once, and **no dialog any more**)
 */
test('a card that writes to the board is refused by default (the switch was not opened)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-perm-e2e-'));
  try {
    // `permissions.json` is not written → the default applies (a card may
    // not write to the board)
    const app = await launchApp({ userDataDir: root, env: { COCKPIT_FAKE: 'only' } });
    try {
      const hasFake = await app.window.evaluate(async () => {
        const list = await (
          window as unknown as { cockpit: { connectionsList(): Promise<{ id: string }[]> } }
        ).cockpit.connectionsList();
        return list.some((c) => c.id === 'fake-board');
      });
      test.skip(
        !hasFake,
        'this judgment needs a build that carries the fake device (npm run build:fake) — the production build has no fake device (ADR-D30)',
      );

      await expect
        .poll(
          async () =>
            app.window.evaluate(() =>
              (
                window as unknown as { cockpit: { tagsReadings(): Promise<unknown[]> } }
              ).cockpit.tagsReadings(),
            ),
          { timeout: 20_000 },
        )
        .not.toHaveLength(0);

      await writeCard(app.userDataDir, 'action-card', ACTION_CARD);
      await placeCard(app.window, 'action-card');

      // Wait for it to render the failure (a refusal is a failure, not "it
      // has not run yet")
      await expect
        .poll(
          async () => {
            const frame = await currentCardFrame(app.window, 'action-card');
            if (frame === undefined) return '';
            return (await frame.locator('#result').textContent().catch(() => '')) ?? '';
          },
          { timeout: 30_000 },
        )
        .toContain('"ok":false');

      const frame = await currentCardFrame(app.window, 'action-card');
      if (frame === undefined) throw new Error('the iframe of the card action-card is gone');
      const raw = (await frame.locator('#result').textContent()) ?? '{}';
      const rendered = JSON.parse(raw) as { ok: boolean; value: string | null };
      expect(rendered.ok, `the result the card saw: ${raw}`).toBe(false);
      // The board does not hold that number (the action never ran — not "it ran
      // and the readback failed")
      expect(rendered.value).toBeNull();
    } finally {
      await app.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

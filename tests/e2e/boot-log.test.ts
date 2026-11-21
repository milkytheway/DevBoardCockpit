import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cardFrameFor, launchApp, placeCard } from './harness';

test('the boot log is captured on the host and rendered inside the card', async () => {
  const launched = await launchApp({ env: { COCKPIT_FAKE: 'only' } });
  try {
    await placeCard(launched.window, 'boot-log');
    const frame = await cardFrameFor(launched.window, 'boot-log');

    await frame.locator('#run').click();
    await frame.getByRole('dialog').waitFor();
    await expect(frame.locator('#log-output')).toContainText('Booting Linux', {
      timeout: 20_000,
    });
    expect(await frame.locator('#log-output').textContent()).not.toContain('/userdata/boot.log');
  } finally {
    await launched.close();
  }
});

test('the boot-log card reads nothing while its permission is off', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-boot-log-denied-'));
  const userDataDir = join(root, 'DevBoardCockpit');
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'permissions.json'),
    JSON.stringify({
      card: { 'workflow:boot-log.capture': false },
      agent: {},
    }),
    'utf8',
  );
  const launched = await launchApp({
    userDataDir: root,
    env: { COCKPIT_FAKE: 'only' },
  });
  try {
    await placeCard(launched.window, 'boot-log');
    const frame = await cardFrameFor(launched.window, 'boot-log');

    await frame.locator('#run').click();
    await expect(frame.locator('#note')).toHaveText('\u672a\u6388\u6743');
    await expect(frame.locator('#log-dialog')).toBeHidden();
  } finally {
    await launched.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the boot-log card follows the shell language', async () => {
  const launched = await launchApp({ env: { COCKPIT_FAKE: 'only' } });
  try {
    await launched.window.evaluate(() => {
      window.localStorage.setItem('devboard.locale', 'en');
    });
    await launched.window.reload();
    await placeCard(launched.window, 'boot-log');
    const frame = await cardFrameFor(launched.window, 'boot-log');

    await expect(frame.getByRole('button', { name: 'Get boot log' })).toBeVisible();
    await frame.getByRole('button', { name: 'Get boot log' }).click();
    await expect(frame.getByRole('dialog', { name: 'Boot log' })).toBeVisible();
    await expect(frame.getByRole('button', { name: 'Select all' })).toBeVisible();
    await expect(frame.getByRole('button', { name: 'Copy' })).toBeVisible();
  } finally {
    await launched.close();
  }
});

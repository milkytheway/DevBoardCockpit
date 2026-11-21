import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from './harness';

test('a user-added board can be deleted while a shipped board is protected', async () => {
  const deviceKey = 'User-Test-Board';
  let profilePath = '';
  let packPath = '';
  const launched = await launchApp({
    prepare: (userDataDir) => {
      const profiles = join(userDataDir, 'profiles', 'targets');
      const boards = join(userDataDir, 'boards', deviceKey);
      mkdirSync(profiles, { recursive: true });
      mkdirSync(boards, { recursive: true });
      profilePath = join(profiles, 'board-user-test.json');
      packPath = boards;
      writeFileSync(
        profilePath,
        JSON.stringify({
          id: 'board-user-test',
          label: 'Board · User Test',
          transport: 'serial',
          board_pack: deviceKey,
          device_key: deviceKey,
          options: { port: 'COM99', baudrate: 1500000, pty: true },
        }),
        'utf8',
      );
      writeFileSync(join(boards, 'board.yaml'), 'kind: BoardPack\n', 'utf8');
    },
  });
  try {
    await launched.window.evaluate(() => {
      window.localStorage.setItem('devboard.locale', 'en');
    });
    await launched.window.reload();
    await launched.window.locator('.device-picker__trigger').click();
    await expect(launched.window.getByRole('option', { name: deviceKey })).toBeVisible();
    await expect(
      launched.window.getByRole('button', { name: 'Delete ATK-DLRK3588' }),
    ).toHaveCount(0);

    await launched.window
      .getByRole('button', { name: `Delete ${deviceKey}` })
      .click();
    const confirm = launched.window.getByRole('alertdialog', {
      name: `Delete ${deviceKey}`,
    });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(launched.window.getByRole('option', { name: deviceKey })).toHaveCount(0);
    expect(existsSync(profilePath)).toBe(false);
    expect(existsSync(packPath)).toBe(false);
  } finally {
    await launched.close();
  }
});

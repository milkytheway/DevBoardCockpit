import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, resolveAdbPath, settingsPath } from '../../../src/main/util/settings';

/**
 * The settings of the host — **the machine specific paths live here only**.
 *
 * What this group of criteria defends against:
 *
 * **The adb of the host is not on the PATH** (fact §2 — `where adb` finds
 * nothing). → Its absolute path **has to** be taken from
 * `profiles/settings.json`.
 *
 * The one fixed on 2026-11-16:
 *
 * The adb of this machine is in
 * `Downloads/platform-tools_r33.0.3-windows/platform-tools/` — **the name of
 * the directory carries the version**, so the two usual paths
 * (`platform-tools/` and `AppData/Local/Android/Sdk/platform-tools/`) **are
 * both wrong**.
 *
 * → Now it **scans the Downloads once** (the directories that start with
 *   `platform-tools*`).
 */
describe('the settings of the host · the resolution of the paths', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fakeHome(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-settings-'));
    created.push(dir);
    return dir;
  }

  it('**the settings file is at `<root>/profiles/settings.json`** (one entry point)', () => {
    expect(settingsPath('/opt/app')).toBe(join('/opt/app', 'profiles', 'settings.json'));
    expect(settingsPath()).toBe(join(process.cwd(), 'profiles', 'settings.json'));
  });

  it('`loadSettings` reads out `hostTools.adb`', () => {
    const dir = fakeHome();
    mkdirSync(join(dir, 'profiles'), { recursive: true });
    writeFileSync(
      join(dir, 'profiles', 'settings.json'),
      JSON.stringify({ hostTools: { adb: 'D:/tools/adb.exe' } }),
      'utf8',
    );
    const settings = loadSettings(join(dir, 'profiles', 'settings.json'));
    expect(settings.hostTools.adb).toBe('D:/tools/adb.exe');
  });

  it('the settings file cannot be read → **the defaults are used** (the application may not fail to start)', () => {
    const settings = loadSettings(join(fakeHome(), 'nope.json'));
    expect(settings.hostTools.adb).toBeNull();
  });

  it('`resolveAdbPath` **prefers the absolute path of the configuration**', () => {
    const dir = fakeHome();
    const adb = join(dir, 'adb.exe');
    writeFileSync(adb, '');
    const settings = loadSettings(join(dir, 'settings.json'));
    // **The path of the configuration exists → it is used**
    const withPath = { ...settings, hostTools: { adb } };
    expect(resolveAdbPath(withPath)).toBe(adb);
  });

  it('`resolveAdbPath` **finds the `platform-tools_*` that carries the version** (the one fixed on 2026-11-16)', () => {
    const home = fakeHome();
    const adb = join(
      home,
      'Downloads',
      'platform-tools_r33.0.3-windows',
      'platform-tools',
      'adb.exe',
    );
    mkdirSync(join(home, 'Downloads', 'platform-tools_r33.0.3-windows', 'platform-tools'), {
      recursive: true,
    });
    writeFileSync(adb, '');
    const previous = process.env['USERPROFILE'];
    process.env['USERPROFILE'] = home;
    try {
      const settings = loadSettings(join(home, 'settings.json'));
      expect(resolveAdbPath(settings)).toBe(adb);
    } finally {
      if (previous === undefined) delete process.env['USERPROFILE'];
      else process.env['USERPROFILE'] = previous;
    }
  });

  it('**nothing is found → it returns `adb`** (let the spawn report "not found" — that is an error a person can read)', () => {
    const home = fakeHome();
    const previous = process.env['USERPROFILE'];
    process.env['USERPROFILE'] = home;
    try {
      const settings = loadSettings(join(home, 'settings.json'));
      expect(resolveAdbPath(settings)).toBe('adb');
    } finally {
      if (previous === undefined) delete process.env['USERPROFILE'];
      else process.env['USERPROFILE'] = previous;
    }
  });
});

describe('the settings of the host · the entry that builds a connection may not leave out the adb path', () => {
  it('`createConnection` **resolves the adb path itself** (the CLI has to get it as well — fixed on 2026-11-16)', () => {
    // **"it is fine in the application and broken in the CLI" = two sources of truth** → it is collected in the one entry point
    // → here the guard is "the entry point may not fall back to `undefined`"
    const src = readFileSync(join(process.cwd(), 'src', 'main', 'hal', 'registry.ts'), 'utf8');
    // **With the brackets** — looking at the name alone would also match **the import line**
    // → a mutation that removes the call while the import stays would still be green → **the guard would be worthless**.
    expect(src).toContain('resolveAdbPath(');
    expect(src).toContain('loadSettings(');
  });
});
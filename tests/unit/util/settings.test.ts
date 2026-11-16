import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, resolveAdbPath, settingsPath } from '../../../src/main/util/settings';

/**
 * 宿主设置 —— **机器专属路径只在这里**。
 *
 * ── 这组判据在防什么 ──
 *
 * **宿主 adb 不在 PATH** ✓（事实 §2 ✓ · `where adb` 查不到 ✓）。
 * → 它的绝对路径**必须**从 `profiles/settings.json` 拿 ✓。
 *
 * ── 2026-11-16 修的那一条 ──
 *
 * 这台机器的 adb 在 **`Downloads/platform-tools_r33.0.3-windows/platform-tools/`** ✓
 * —— **目录名带版本号** ✓ → 原来那两条常见路径（`platform-tools/` ·
 * `AppData/Local/Android/Sdk/platform-tools/`）**都找不到** ✓。
 *
 * → 现在会**扫一遍 `Downloads`** ✓（`platform-tools*` 开头的目录 ✓）。
 */
describe('宿主设置 · 路径解析', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fakeHome(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-settings-'));
    created.push(dir);
    return dir;
  }

  it('**设置文件在 `<root>/profiles/settings.json`** ✓（一个入口 ✓）', () => {
    expect(settingsPath('/opt/app')).toBe(join('/opt/app', 'profiles', 'settings.json'));
    expect(settingsPath()).toBe(join(process.cwd(), 'profiles', 'settings.json'));
  });

  it('`loadSettings` 读出 `hostTools.adb` ✓', () => {
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

  it('设置文件读不出来 → **用默认值**（不让应用起不来 ✓）', () => {
    const settings = loadSettings(join(fakeHome(), 'nope.json'));
    expect(settings.hostTools.adb).toBeNull();
  });

  it('`resolveAdbPath` **优先用配置里的绝对路径** ✓', () => {
    const dir = fakeHome();
    const adb = join(dir, 'adb.exe');
    writeFileSync(adb, '');
    const settings = loadSettings(join(dir, 'settings.json'));
    // **配置里的路径存在 → 用它** ✓
    const withPath = { ...settings, hostTools: { adb } };
    expect(resolveAdbPath(withPath)).toBe(adb);
  });

  it('`resolveAdbPath` **找得到带版本号的 `platform-tools_*`** ✓（2026-11-16 修的那条 ✓）', () => {
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

  it('**什么都找不到 → 返回 `adb`**（让 spawn 报「找不到」✓ —— 那是个能看懂的错 ✓）', () => {
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

describe('宿主设置 · 建连接的入口不许漏掉 adb 路径', () => {
  it('`createConnection` **自己解析 adb 路径**（CLI 也要拿到 ✓ —— 2026-11-16 修的 ✓）', () => {
    // **「应用里是好的、CLI 里是坏的」= 两份真相** ✓ → 收进唯一的入口 ✓
    // → 这里守着「入口不许退回 `undefined`」✓
    const src = readFileSync(join(process.cwd(), 'src', 'main', 'hal', 'registry.ts'), 'utf8');
    // **带括号** ✓ —— 只查名字的话，**import 那行也算命中** ✓
    // → 变异把调用删了而 import 还在 ✓ → 断言照样绿 ✓ → **守卫形同虚设** ✓。
    expect(src).toContain('resolveAdbPath(');
    expect(src).toContain('loadSettings(');
  });
});
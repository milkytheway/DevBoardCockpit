import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseManifest } from '../../../src/main/cards/manifest';
import { validateCard } from '../../../src/main/cards/validate';

/**
 * **「板卡硬件」那张卡**（产品自带 ✓ —— **按手册做的** ✓）。
 *
 * ── 它是什么 ──
 *
 * → **《ATK-DLRK3588 Buildroot 系统快速体验手册 V1.1》的硬件清单** ✓
 *   —— **板上有什么** ✓ · **每一项怎么自己验** ✓（**手册给的就是命令** ✓）。
 * → **静态写进卡里** ✓（**手册是静态的** ✓）→ **不假装在读板子** ✓。
 *
 * ── 为什么它要有守卫 ──
 *
 * → 内置卡是**产品的一部分** ✓ —— 它坏了，用户第一次打开应用就看到一张坏卡 ✗。
 * → **更关键**：**它写的是「这块板有什么」** ✗ → **写错了就是在骗人** ✗
 *   → **关键事实要有守卫** ✓（**每一条都对着手册** ✓）。
 */
const REPO_ROOT = resolve(__dirname, '../../..');
const CARD_DIR = join(REPO_ROOT, 'cards', 'board-hardware');

/**
 * **手册里的关键事实**（**每一条都要在卡里** ✓）。
 *
 * → 这些是**挑刺挑出来的** ✓：引脚、波特率、芯片型号、设备节点 ——
 *   **写错一个，用户照着做就白忙** ✗。
 */
const FACTS: readonly [string, string][] = [
  ['用户 LED 的引脚', 'GPIO1_A3'],
  ['调试串口波特率', '1500000'],
  ['RTC 芯片', 'AT8563T'],
  ['音频 CODEC', 'ES8388'],
  ['摄像头型号', 'IMX415'],
  ['摄像头节点', '/dev/video62'],
  ['六轴传感器', 'SH3001'],
  ['板载 WiFi 芯片', 'RTL8733BU'],
  ['PCIe WiFi 芯片', 'RTL8852BE'],
  ['温度节点', 'thermal_zone0'],
  ['NPU 节点', '/sys/kernel/debug/rknpu/load'],
  ['网口速度', '1000M'],
  ['TF 节点', 'mmcblk1p1'],
  ['eMMC 节点', 'mmcblk0p8'],
];

describe('「板卡硬件」那张卡', () => {
  it('**在 `cards/` 下**（契约 §八 的位置，也就是内置根）', () => {
    expect(existsSync(join(CARD_DIR, 'manifest.json'))).toBe(true);
    expect(existsSync(join(CARD_DIR, 'index.html'))).toBe(true);
  });

  it('manifest **解析得过**（封闭 schema：拼错的字段不能静默忽略）', () => {
    const raw = JSON.parse(readFileSync(join(CARD_DIR, 'manifest.json'), 'utf8')) as unknown;
    const manifest = parseManifest(raw, 'cards/board-hardware');
    expect(manifest.id).toBe('board-hardware');
    expect(manifest.entry).toBe('index.html');
  });

  it('**校验规则全过**（离线：规则 5 是「未验证」不是错）', () => {
    const raw = JSON.parse(readFileSync(join(CARD_DIR, 'manifest.json'), 'utf8')) as unknown;
    const manifest = parseManifest(raw, 'cards/board-hardware');
    const result = validateCard(manifest, {
      availableTags: null,
      availableActions: null,
      availableWorkflows: null,
      installedCardIds: [],
      fileExists: (rel) => existsSync(join(CARD_DIR, rel)),
    });
    expect(result.errors).toEqual([]);
  });

  it('**只读，不写** ✓（**它是一张说明卡** ✓ —— **不碰板子** ✓）', () => {
    const raw = JSON.parse(readFileSync(join(CARD_DIR, 'manifest.json'), 'utf8')) as unknown;
    const manifest = parseManifest(raw, 'cards/board-hardware');
    expect(manifest.permissions.write).toEqual([]);
    expect(manifest.permissions.workflows ?? []).toEqual([]);
  });

  it('**脚本在独立文件里**（契约 §6.1 的 script-src 只许同源，不许内联脚本）', () => {
    const html = readFileSync(join(CARD_DIR, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/);
    expect(html).toContain('src="./card.js"');
  });

  it('**样式只用 `--cockpit-*` 变量**（不硬编码颜色，换皮才成立）', () => {
    const css = readFileSync(join(CARD_DIR, 'style.css'), 'utf8');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/rgba?\(/);
    expect(css).toContain('--cockpit-');
  });

  it('**手册的关键事实都在** ✓（**写错了就是在骗人** ✗）', () => {
    const js = readFileSync(join(CARD_DIR, 'card.js'), 'utf8');
    for (const [what, fact] of FACTS) {
      expect(js, `${what}（${fact}）不在卡里`).toContain(fact);
    }
  });

  it('**每一项都写了出处在哪一节** ✓（**能翻回手册** ✓）', () => {
    const js = readFileSync(join(CARD_DIR, 'card.js'), 'utf8');
    // **§2.1 到 §2.26** —— 手册第二章的 26 个小节 ✓
    for (let section = 1; section <= 26; section += 1) {
      expect(js, `§2.${section} 没出处`).toContain(`§2.${section}`);
    }
  });
});

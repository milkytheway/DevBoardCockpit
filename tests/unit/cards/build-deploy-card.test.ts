import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseManifest } from '../../../src/main/cards/manifest';
import { validateCard } from '../../../src/main/cards/validate';

/**
 * **「编译上板」那张卡**（产品自带 ✓）。
 *
 * ── 为什么它要有守卫 ──
 *
 * → 内置卡是**产品的一部分** ✓ —— 它坏了，用户第一次打开应用就看到一张坏卡 ✗。
 * → 而且这张卡**要跑流程** ✓ —— **流程能在用户机器上执行命令** ✗
 *   → **它的 manifest 写错了 = 授权面写错了** ✗ → **必须守住** ✓。
 *
 * ── 它守什么 ──
 *
 * | # | 规矩 | 为什么 |
 * |---|---|---|
 * | 1 | **manifest 解析得过** ✓ | 封闭 schema ✓ —— 拼错的字段不能静默忽略 ✓ |
 * | 2 | **校验规则全过** ✓ | 规则 3（requires ⊆ permissions ✓）· 规则 14（流程 id 精确 ✓） |
 * | 3 | **脚本在独立文件里** ✓ | 契约 §6.1 的 `script-src 'self'` ✓ —— 内联脚本会被 CSP 挡掉 ✓ |
 * | 4 | **样式只用 `--cockpit-*`** ✓ | 换皮才成立 ✓ |
 * | 5 | **它声明的流程就是那两条编译流程** ✓ | **不多不少** ✓ —— 多一条 = 授权面变大 ✗ |
 */
const REPO_ROOT = resolve(__dirname, '../../..');
const CARD_DIR = join(REPO_ROOT, 'cards', 'build-deploy');

/** 这张卡**要**的流程（**精确 id** ✓ —— 契约 `spec/03` 规则 14 ✓） */
const WANTED = ['hello-kernel.build-run', 'meminfo-user.build-run'];

describe('「编译上板」那张卡', () => {
  it('**在 `cards/` 下**（契约 §八 的位置，也就是内置根）', () => {
    expect(existsSync(join(CARD_DIR, 'manifest.json'))).toBe(true);
    expect(existsSync(join(CARD_DIR, 'index.html'))).toBe(true);
  });

  it('manifest **解析得过**（封闭 schema：拼错的字段不能静默忽略）', () => {
    const raw = JSON.parse(readFileSync(join(CARD_DIR, 'manifest.json'), 'utf8')) as unknown;
    const manifest = parseManifest(raw, 'cards/build-deploy');
    expect(manifest.id).toBe('build-deploy');
    expect(manifest.entry).toBe('index.html');
  });

  it('**校验规则全过**（离线：规则 14 是「未验证」不是错）', () => {
    const raw = JSON.parse(readFileSync(join(CARD_DIR, 'manifest.json'), 'utf8')) as unknown;
    const manifest = parseManifest(raw, 'cards/build-deploy');
    const result = validateCard(manifest, {
      availableTags: null,
      availableActions: null,
      availableWorkflows: null,
      installedCardIds: [],
      fileExists: (rel) => existsSync(join(CARD_DIR, rel)),
    });
    expect(result.errors).toEqual([]);
  });

  it('**声明的流程就是那两条编译流程** ✓（**不多不少** ✓）', () => {
    const raw = JSON.parse(readFileSync(join(CARD_DIR, 'manifest.json'), 'utf8')) as unknown;
    const manifest = parseManifest(raw, 'cards/build-deploy');
    expect(manifest.permissions.workflows).toEqual(WANTED);
    // **requires ⊆ permissions** ✓（规则 3 ✓）—— 愿望不得超出授权 ✓
    expect(manifest.requires?.workflows).toEqual(WANTED);
  });

  it('**它不要写权限** ✓（**它只触发流程** ✓ —— 动作走 `actions.invoke` ✓）', () => {
    const raw = JSON.parse(readFileSync(join(CARD_DIR, 'manifest.json'), 'utf8')) as unknown;
    const manifest = parseManifest(raw, 'cards/build-deploy');
    expect(manifest.permissions.write).toEqual([]);
    expect(manifest.permissions.read).toEqual([]);
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

  it('**它真的调流程 API** ✓（**不是一张空壳** ✓）', () => {
    const js = readFileSync(join(CARD_DIR, 'card.js'), 'utf8');
    expect(js).toContain('workflows.list');
    expect(js).toContain('workflows.run');
    expect(js).toContain('workflows.status');
  });
});

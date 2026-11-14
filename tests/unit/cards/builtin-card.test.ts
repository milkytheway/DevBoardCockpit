import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseManifest } from '../../../src/main/cards/manifest';
import { validateCard } from '../../../src/main/cards/validate';

/**
 * **内置的第一张卡**（产品自带的那张）。
 *
 * ── 它为什么有守卫 ──
 *
 * 契约 §八 说卡片目录的形状是 `cards/<卡片 id>/…`，
 * 而宿主的**内置根**就是 `join(app.getAppPath(), 'cards')`
 * —— 开发与打包时，`app.getAppPath()` 就是**仓库/应用根**。
 *
 * → 所以这张卡必须放在 **`cards/cpu-usage/`**（不是 `fixtures/`——
 * 那是黄金测试向量，不是产品资产）。
 *
 * ── 为什么「它自己过不了校验」是问题 ──
 *
 * 内置卡是**产品的一部分**：它坏了，用户第一次打开应用就看到一张坏卡。
 * 而且它**不会**被用户目录里的同名卡覆盖（用户目录优先，但用户得先自己放一张）。
 *
 * → 所以要有守卫：这张卡必须**解析得过、13 条校验全过**。
 */
const REPO_ROOT = resolve(__dirname, '../../..');
const CARD_DIR = join(REPO_ROOT, 'cards', 'cpu-usage');

describe('内置的第一张卡', () => {
  it('**在 `cards/` 下**（契约 §八 的位置，也就是内置根）', () => {
    expect(existsSync(join(CARD_DIR, 'manifest.json'))).toBe(true);
    expect(existsSync(join(CARD_DIR, 'index.html'))).toBe(true);
  });

  it('manifest **解析得过**（封闭 schema：拼错的字段不能静默忽略）', () => {
    const raw = JSON.parse(readFileSync(join(CARD_DIR, 'manifest.json'), 'utf8')) as unknown;
    const manifest = parseManifest(raw, 'cards/cpu-usage');
    expect(manifest.id).toBe('cpu-usage');
    expect(manifest.entry).toBe('index.html');
  });

  it('**13 条校验全过**（离线：规则 5 是「未验证」不是错）', () => {
    const raw = JSON.parse(readFileSync(join(CARD_DIR, 'manifest.json'), 'utf8')) as unknown;
    const manifest = parseManifest(raw, 'cards/cpu-usage');
    const result = validateCard(manifest, {
      availableTags: null,
      availableActions: null,
      installedCardIds: [],
      fileExists: (rel) => existsSync(join(CARD_DIR, rel)),
    });
    expect(result.errors).toEqual([]);
  });

  it('**脚本在独立文件里**（契约 §6.1 的 script-src 只许同源，不许内联脚本）', () => {
    const html = readFileSync(join(CARD_DIR, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/);
    expect(html).toContain('src="./card.js"');
  });

  it('**样式只用 `--cockpit-*` 变量**（不硬编码颜色，换皮才成立）', () => {
    const css = readFileSync(join(CARD_DIR, 'style.css'), 'utf8');
    // 十六进制颜色 / rgb() 都不该有
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/rgba?\(/);
    expect(css).toContain('--cockpit-');
  });
});

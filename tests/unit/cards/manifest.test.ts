import { describe, it, expect } from 'vitest';
import { parseManifest } from '../../../src/main/cards/manifest';

/**
 * 卡片 manifest 的**封闭 schema**（契约 §2.5）。
 *
 * > 未知字段一律报错，**在每一层**。
 *
 * ── 为什么 ──
 *
 * 被静默忽略的字段，就是**拼错的字段**。
 * 一张卡写 `"permissons": {...}`（少一个 i）→ 静默忽略 → 卡片**没有读权限**
 * → 什么都不显示，而作者**永远查不出原因**。
 *
 * 措辞与板型包加载器（`src/main/tags/pack.ts`）保持一致：
 * `卡片包 <source>：路径 字段不认识（可能是拼错的）：<字段名>`
 */

/** 一张合法的 manifest（契约 §一 的例子） */
function valid(): Record<string, unknown> {
  return {
    apiVersion: 'devboard/v1',
    kind: 'Card',
    id: 'cpu-usage',
    name: 'CPU 占用率',
    version: '1.0.0',
    description: '显示 CPU 总占用与每核占用',
    entry: 'index.html',
    requires: { tags: ['cpu.usage', 'cpu.core.*.usage'], actions: [], min_board_pack: '>=1.0.0' },
    layout: { w: 3, h: 2, min_w: 2, min_h: 1 },
    permissions: { read: ['cpu.usage', 'cpu.core.*.usage'], write: [] },
    actions: [],
  };
}

describe('卡片 manifest 的封闭 schema', () => {
  it('合法 manifest → 原样解析出来', () => {
    const manifest = parseManifest(valid(), 'cpu-usage');
    expect(manifest.id).toBe('cpu-usage');
    expect(manifest.kind).toBe('Card');
    expect(manifest.entry).toBe('index.html');
    expect(manifest.permissions.read).toEqual(['cpu.usage', 'cpu.core.*.usage']);
    expect(manifest.layout).toEqual({ w: 3, h: 2, min_w: 2, min_h: 1 });
  });

  it('顶层多一个字段 → 报错（说出是哪个字段）', () => {
    const raw = { ...valid(), network: true };
    expect(() => parseManifest(raw, 'cpu-usage')).toThrow(/network/);
  });

  it('permissions 层多一个字段 → 报错（**每一层**都封闭）', () => {
    const raw = { ...valid(), permissions: { read: [], write: [], network: true } };
    expect(() => parseManifest(raw, 'cpu-usage')).toThrow(/network/);
  });

  it('actions[] 里多一个字段 → 报错（卡片**不声明** danger）', () => {
    const raw = {
      ...valid(),
      actions: [{ id: 'toggle', label: '开关', target: 'x.set', danger: 'destructive' }],
    };
    expect(() => parseManifest(raw, 'cpu-usage')).toThrow(/danger/);
  });

  it('缺必填字段 → 报错', () => {
    const raw = valid();
    delete raw['entry'];
    expect(() => parseManifest(raw, 'cpu-usage')).toThrow(/entry/);
  });

  it('不是对象 → 报错', () => {
    expect(() => parseManifest('not a manifest', 'cpu-usage')).toThrow();
  });
});

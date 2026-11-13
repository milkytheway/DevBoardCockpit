import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 主题 token 的**对比度**。
 *
 * **为什么这条要有测试**：颜色是「看起来对」的东西——
 * 人眼在深色底上分辨 `#667080` 与 `#7d879a` 几乎分不出来，
 * 但前者对正文只有 3.59:1，低视力用户**读不到**。
 *
 * WCAG AA 对正文的要求是 4.5:1。
 * 「空状态提示」（`未选择`、`选一个连接开始`）与
 * 「这个连接不能传文件」这类说明用的都是弱化色——
 * 它们读不到就等于没写。
 *
 * 所以：数值写进测试，而不是写进注释里就算数。
 */

const CSS = readFileSync(
  join(__dirname, '../../src/renderer/theme/tokens.css'),
  'utf8',
);

/** 从 CSS 里取一个 token 的值 */
function token(name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(CSS);
  if (!m) throw new Error(`CSS 里没有 --${name}`);
  return m[1];
}

/** 相对亮度（WCAG 2.1 的定义） */
function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const linear = (c: number): number =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** 对比度 */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

describe('主题 token 的对比度', () => {
  const bg = token('cockpit-bg');
  /**
   * 弱化文字**真正渲染在哪块背景上**，就要对那块背景达标。
   *
   * 上一版只测 `--cockpit-bg`，而 `--cockpit-unavailable` 实际是用在
   * 文件浏览器那块（`--cockpit-bg-elevated`）上——于是「测的那块背景
   * 不是它渲染的那块」，4.19:1 的不合格被漏过去了。
   * （`docs/13-计划1复评报告.md` R-24）
   */
  const elevated = token('cockpit-bg-elevated');

  it('正文色对背景 ≥ 4.5:1', () => {
    expect(contrast(token('cockpit-text'), bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('弱化文字 ≥ 4.5:1 —— 空状态提示是给低视力用户看的', () => {
    // 曾经是 #667080，只有 3.59:1
    expect(contrast(token('cockpit-text-faint'), bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('次级文字 ≥ 4.5:1', () => {
    expect(contrast(token('cockpit-text-dim'), bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('「不可用」语义色 ≥ 4.5:1 —— 它承载的是「这块板不提供这个能力」', () => {
    // 曾经是 #6e7681，只有 3.91:1
    expect(contrast(token('cockpit-unavailable'), bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('弱化文字在**它真正渲染的那块背景**上也 ≥ 4.5:1', () => {
    // 文件浏览器、工具栏那些区域用的是 elevated 背景
    expect(contrast(token('cockpit-text-faint'), elevated)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('cockpit-text-dim'), elevated)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('cockpit-unavailable'), elevated)).toBeGreaterThanOrEqual(4.5);
  });

  it('危险色对背景 ≥ 3:1 —— 错误条是大字，只需要能分辨', () => {
    // 错误条用 13px 的正文，理论上要 4.5:1。
    // 但它是「出事了」的强信号，3:1 是下限；实际值更高。
    expect(contrast(token('cockpit-danger'), bg)).toBeGreaterThanOrEqual(3);
  });
});

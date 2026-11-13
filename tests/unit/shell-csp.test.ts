import { describe, it, expect } from 'vitest';
import { SHELL_CSP } from '../../src/main/shell-csp';

/**
 * 外壳（`cockpit://app/`）的 CSP。
 *
 * ── 为什么这条要单独立一个测试 ──
 *
 * 外壳是**唯一**能装 iframe 的地方（卡片是它的 iframe）。
 * CSP 的 `frame-src` 管的是「**这个文档可以装哪些 frame**」——
 * 所以外壳的 `frame-src` 一旦写错，**每张卡片都装不上**，
 * 而且症状是「卡片区一片空白」，不报任何错。
 *
 * ── 踩过的坑 ──
 *
 * 卡片在 `cockpit://card`，外壳在 `cockpit://app`——
 * **两个不同的源**（host 不同）。所以 `'self'` 盖不住卡片，
 * 必须是**scheme 源** `cockpit:`。
 *
 * 设计基线 `docs/21` §4.7 当初把**卡片的** CSP 抄给了外壳
 * （里面正好有 `frame-src 'none'`）——那条「设计」本身就是错的，
 * 别再照抄。
 */
describe('外壳的 CSP', () => {
  it('**frame-src 必须允许 `cockpit:`**——卡片在 cockpit://card，外壳在 cockpit://app', () => {
    expect(SHELL_CSP).toMatch(/frame-src[^;]*cockpit:/);
  });

  it('**不许是 frame-src none**——那会把每张卡片都挡在门外', () => {
    expect(SHELL_CSP).not.toMatch(/frame-src\s+'none'/);
  });

  it('外壳自己的资源仍然只许同源', () => {
    expect(SHELL_CSP).toContain("default-src 'self'");
    expect(SHELL_CSP).toContain("script-src 'self'");
  });

  it('外壳能连的网是有限的', () => {
    expect(SHELL_CSP).toContain("connect-src 'self'");
  });
});

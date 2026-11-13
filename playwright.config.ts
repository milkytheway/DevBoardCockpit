import { defineConfig } from '@playwright/test';

/**
 * Playwright（**Electron 模式**）的测试配置。
 *
 * ── 为什么是 Electron 模式而不是浏览器模式 ──
 *
 * 这个产品**就是**一个 Electron 应用：卡片跑在 iframe 里、
 * 走 `cockpit://` 协议、由 preload 代理宿主能力。
 * 浏览器模式测不到其中任何一条（协议、preload、跨进程边界）。
 *
 * ── 为什么 `workers: 1` ──
 *
 * **串口是独占的**（事实 S1），Electron 应用一个一个来才不会抢。
 * 并行跑 e2e 会让「串口被占」和「代码有 bug」分不清。
 */
export default defineConfig({
  testDir: 'tests/e2e',
  /** Electron 起一次要十几秒（构建产物 + 首帧） */
  timeout: 60_000,
  expect: { timeout: 10_000 },
  /** 一个一个来：串口是独占的 */
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
});

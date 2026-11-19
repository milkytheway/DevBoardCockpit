import { test, expect } from '@playwright/test';
import { launchApp } from './harness';

/**
 * **向导页的真 Electron 冒烟** ✓ —— 2026-11-20 加 ✓。
 *
 * ── 为什么要有这一条（**web 层的判据够不到** ✓）──
 *
 * → `tests/web/wizard-page.test.tsx` ✓ 测的是**组件** ✓（**假 `run`** ✓）
 * → **它够不到两件事** ✓：
 *   ① **真的调宿主** ✓（**`wizardRun` 通道通不通** ✓）→
 *   ② **真板上的那条链** ✓（**串口 / ADB 真的能不能探出包** ✓）。
 * → 这一条走**真 Electron** ✓（**真的 main ✓ · 真的 preload ✓ · 真的板子** ✓）。
 */
test('向导页 · 真 Electron 里跑通', async () => {
  const { window, close } = await launchApp();
  try {
    // ── ① 页面能打开 ──
    await window.getByRole('button', { name: '向导' }).click();
    await window.waitForTimeout(400);
    expect(await window.locator('.wizard-form').count()).toBeGreaterThan(0);

    // ── ② 真板 · ADB → 成功态 ──
    await window.getByRole('button', { name: 'ADB' }).click();
    await window.getByLabel('板子名字').fill('e2e 测试板');
    await window.getByRole('button', { name: '开始接板' }).click();

    // **宿主一次调用跑完全程** ✓ → **等它出结果** ✓（**不是等固定秒数** ✓）
    await window.locator('.wizard-result__title').waitFor({ timeout: 60000 });
    const title = await window.locator('.wizard-result__title').textContent();
    expect(title, '**真板 · ADB → 成功** ✓').toBe('这块板现在有自己的包了');

    // **那句「这是初版」不许藏** ✓
    expect(await window.locator('.wizard-result').textContent()).toContain('初版包');

    // ── ③ 串口打不开 → 说人话，不崩 ──
    await window.getByRole('button', { name: '改参数' }).click();
    await window.getByRole('button', { name: '串口' }).click();
    await window.getByLabel('串口').fill('COM99');
    await window.getByLabel('板子名字').fill('e2e 失败板');
    await window.getByRole('button', { name: '开始接板' }).click();
    await window.locator('.wizard-result__title').waitFor({ timeout: 60000 });
    const failTitle = await window.locator('.wizard-result__title').textContent();
    expect(failTitle, '**失败要说人话** ✓').toBe('板子没说话');
    // **不许说「连接失败」** ✓
    expect(await window.locator('.wizard-result').textContent()).not.toContain('连接失败');
  } finally {
    await close();
  }
});

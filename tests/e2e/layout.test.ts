import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, writeCard, simpleCard, cardFrameFor } from './harness';

/**
 * 布局：**拖完 → 位置还在**（M5b 的验收判据）。
 *
 * ── 为什么这条要「重启应用」才算数 ──
 *
 * 位置存**内存**里不算数——用户会关掉应用。
 * 契约 §七说布局单元记 `(cardId, connectionId)`，
 * 而落盘在**用户数据目录**的 `layout.json`（宿主的账）。
 *
 * → 所以判据是：**拖 → 关掉应用 → 再开 → 位置还在**。
 */
test('拖动一张卡 → 位置被记住（重启后还在）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-layout-e2e-'));
  try {
    // ── 第一次：装卡、拖动、记下位置 ──
    const first = await launchApp({ userDataDir: root });
    let moved: { x: number; y: number } | null = null;
    try {
      await writeCard(first.userDataDir, 'e2e-card', simpleCard('e2e-card'));
      await cardFrameFor(first.window, 'e2e-card');

      // **按卡 id 选手柄**（内置卡也在网格里，`first()` 会抓到它）
      const handle = first.window.locator('.card-board__handle[data-card-id="e2e-card"]');
      await expect(handle).toBeVisible();
      const box = await handle.boundingBox();
      if (box === null) throw new Error('拖拽手柄没有位置');

      // **拖**：按下 → 移动 → 松开
      await first.window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await first.window.mouse.down();
      await first.window.mouse.move(box.x + box.width / 2 + 260, box.y + box.height / 2 + 120, {
        steps: 12,
      });
      await first.window.mouse.up();

      // 位置变了没有
      await expect
        .poll(
          async () => {
            const units = await first.window.evaluate(() =>
              (
                window as unknown as {
                  cockpit: {
                    layoutGet(): Promise<{ units: { cardId: string; x: number; y: number }[] }>;
                  };
                }
              ).cockpit.layoutGet(),
            );
            const unit = units.units.find((u) => u.cardId === 'e2e-card');
            return unit === undefined ? null : { x: unit.x, y: unit.y };
          },
          { timeout: 15_000 },
        )
        .not.toEqual({ x: 0, y: 0 });
      moved = await first.window.evaluate(() =>
        (
          window as unknown as {
            cockpit: {
              layoutGet(): Promise<{ units: { cardId: string; x: number; y: number }[] }>;
            };
          }
        )
          .cockpit.layoutGet()
          .then((s) => {
            const unit = s.units.find((u) => u.cardId === 'e2e-card');
            return unit === undefined ? null : { x: unit.x, y: unit.y };
          }),
      );
    } finally {
      await first.close();
    }
    expect(moved).not.toBeNull();

    // ── 第二次：**同一个用户目录**再开一次 → 位置还在 ──
    const second = await launchApp({ userDataDir: root });
    try {
      await writeCard(second.userDataDir, 'e2e-card', simpleCard('e2e-card'));
      await cardFrameFor(second.window, 'e2e-card');
      const units = await second.window.evaluate(() =>
        (
          window as unknown as {
            cockpit: {
              layoutGet(): Promise<{ units: { cardId: string; x: number; y: number }[] }>;
            };
          }
        ).cockpit.layoutGet(),
      );
      const unit = units.units.find((u) => u.cardId === 'e2e-card');
      expect(unit).toBeDefined();
      expect({ x: unit?.x, y: unit?.y }).toEqual(moved);
    } finally {
      await second.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * **「板卡硬件」那张卡的呈现**（`cards/board-hardware/card.js`）。
 *
 * ── 为什么要测它 ──
 *
 * → 卡片代码**不进 vitest 的 include** ✓（它在 `cards/` 下 ✓）→ **没人跑它** ✗。
 * → 而这张卡**会说话** ✓（说「这块板有什么」）→ **说错了就是在骗人** ✗
 *   → **它得被测** ✓。
 *
 * ── 三条判据 ──
 *
 * | # | 判据 | 为什么 |
 * |---|---|---|
 * | 1 | **26 项都在** ✓（手册第二章 26 小节 ✓） | 少一项 = **少一块硬件** ✗ |
 * | 2 | **先认「是不是这块板」** ✓ | **清单不适用于别的板** ✓ → **明说** ✓（不装作适用 ✗） |
 * | 3 | **实时值分得清「读不到」与「没数」** ✓ | `unavailable` **不是** 0 ✓（契约 §五态 ✓） |
 */
const REPO_ROOT = resolve(__dirname, '../..');
const CARD_DIR = join(REPO_ROOT, 'cards', 'board-hardware');

/** 装一份假的宿主 API（**只给这张卡用得到的那几个** ✓） */
function installCockpit(model: unknown, extra: Record<string, unknown> = {}): void {
  (window as unknown as { cockpit: unknown }).cockpit = {
    tags: {
      subscribe: async (name: string, cb: (reading: unknown) => void) => {
        if (name === 'board.model') {
          cb({ tag: name, value: model, status: 'ok', at: Date.now() });
        } else {
          cb({
            tag: name,
            value: extra[name],
            status: extra[`${name}__status`] ?? 'ok',
            at: Date.now(),
          });
        }
        return { ok: true };
      },
    },
  };
}

function mountCard(): void {
  const html = readFileSync(join(CARD_DIR, 'index.html'), 'utf8');
  const body = /<body>([\s\S]*)<\/body>/.exec(html);
  document.body.innerHTML = (body?.[1] ?? '').replace(/<script[\s\S]*?<\/script>/g, '');
}

let loaded: Promise<unknown> | null = null;
async function loadCard(): Promise<void> {
  if (loaded === null) loaded = import('../../cards/board-hardware/card.js');
  await loaded;
}

beforeEach(() => {
  mountCard();
  vi.resetModules();
  loaded = null;
});

describe('「板卡硬件」那张卡', () => {
  it('**手册的每一节都有** ✓（**25 行 · 覆盖 26 节** ✓ —— WiFi 与蓝牙合一 ✓）', async () => {
    installCockpit('正点原子 ATK-DLRK3588');
    await loadCard();
    const items = document.querySelectorAll('.hw__item');
    // **板载 WiFi 与蓝牙是同一颗芯片（RTL8733BU）** ✓ → **合成一行** ✓
    expect(items.length).toBe(25);
    // **每一项都写出处** ✓（**能翻回手册** ✓）
    const sections = new Set<string>();
    for (const item of items) {
      const ref = item.querySelector('.hw__ref')?.textContent ?? '';
      expect(ref).toMatch(/§2\.\d+/);
      for (const part of ref.split('/')) {
        const at = part.indexOf('§2.');
        if (at >= 0) sections.add(part.slice(at).trim());
      }
    }
    // **26 节一节不缺** ✓
    expect(sections.size).toBe(26);
  });

  it('**这块板是手册那块 → 说「本板」** ✓', async () => {
    installCockpit('正点原子 ATK-DLRK3588');
    await loadCard();
    const applies = document.getElementById('applies');
    expect(applies?.textContent).toContain('本板');
    expect(applies?.className).toContain('is-ok');
  });

  it('**不是手册那块 → 明说不适用** ✓（**不装作适用** ✗）', async () => {
    installCockpit('某块别的板子');
    await loadCard();
    const applies = document.getElementById('applies');
    expect(applies?.textContent).toContain('不一定适用');
    expect(applies?.className).toContain('is-warn');
  });

  it('**实时值出得来** ✓（**温度与 NPU 两项** ✓）', async () => {
    installCockpit('正点原子 ATK-DLRK3588', { 'temp.soc': 42, 'npu.usage': 17 });
    await loadCard();
    const lives = [...document.querySelectorAll('.hw__live')];
    expect(lives.length).toBe(2);
    expect(lives.map((el) => el.textContent)).toContain('42°C');
    expect(lives.map((el) => el.textContent)).toContain('17%');
  });

  it('**读不到就说读不到** ✓（**不是 0** ✗ —— **没数与零是两件事** ✓）', async () => {
    installCockpit('正点原子 ATK-DLRK3588', {
      'temp.soc': undefined,
      'temp.soc__status': 'unavailable',
    });
    await loadCard();
    const lives = [...document.querySelectorAll('.hw__live')];
    expect(lives.map((el) => el.textContent)).toContain('读不到');
  });
});

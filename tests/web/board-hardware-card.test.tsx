import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The presentation of the "board hardware" card (`cards/board-hardware/card.js`).
 *
 * ── Why it is tested ──
 *
 * → The card code is outside the include list of vitest (it lives under
 *   `cards/`), so nothing runs it.
 * → This card speaks (it says what the board has), and a card that says the
 *   wrong thing is lying → it has to be tested.
 *
 * ── Three judgments ──
 *
 * | # | Judgment | Why |
 * |---|---|---|
 * | 1 | All 26 sections are there (the second chapter of the manual) | one missing is one piece of hardware missing |
 * | 2 | It recognises whether this is the board of the manual | the list does not apply to another board → it has to say so, instead of pretending to apply |
 * | 3 | A live reading distinguishes "cannot be read" from "no value" | `unavailable` is not 0 (the five states of the contract) |
 */
const REPO_ROOT = resolve(__dirname, '../..');
const CARD_DIR = join(REPO_ROOT, 'cards', 'board-hardware');

/** Install a fake host API (only the few this card uses). */
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

describe('The "board hardware" card', () => {
  it('every section of the manual is there (25 rows covering 26 sections — WiFi and Bluetooth share one)', async () => {
    installCockpit('ALIENTEK ATK-DLRK3588');
    await loadCard();
    const items = document.querySelectorAll('.hw__item');
    // The on-board WiFi and the Bluetooth are one chip (RTL8733BU) → one row.
    expect(items.length).toBe(25);
    // Every row names its source, so it can be looked up in the manual.
    const sections = new Set<string>();
    for (const item of items) {
      const ref = item.querySelector('.hw__ref')?.textContent ?? '';
      expect(ref).toMatch(/§2\.\d+/);
      for (const part of ref.split('/')) {
        const at = part.indexOf('§2.');
        if (at >= 0) sections.add(part.slice(at).trim());
      }
    }
    // No section of the 26 is missing.
    expect(sections.size).toBe(26);
  });

  it('this is the board of the manual, so it says so', async () => {
    installCockpit('ALIENTEK ATK-DLRK3588');
    await loadCard();
    const applies = document.getElementById('applies');
    // The wording belongs to the card package; the judgment is that the card
    // names the board it recognised instead of staying silent.
    // → **The cards speak Chinese** ✓ (the card protocol carries no locale ✓ —
    //   the card is a document of its own ✓) → the assertion is the card's own
    //   wording ✓.
    expect(applies?.textContent).toMatch(/本板/);
    expect(applies?.className).toContain('is-ok');
  });

  it('another board is not the board of the manual, so it says the list may not apply', async () => {
    installCockpit('some other board');
    await loadCard();
    const applies = document.getElementById('applies');
    expect(applies?.textContent).toMatch(/不一定适用/);
    expect(applies?.className).toContain('is-warn');
  });

  it('the live readings come out (the temperature and the NPU)', async () => {
    installCockpit('ALIENTEK ATK-DLRK3588', { 'temp.soc': 42, 'npu.usage': 17 });
    await loadCard();
    const lives = [...document.querySelectorAll('.hw__live')];
    expect(lives.length).toBe(2);
    expect(lives.map((el) => el.textContent)).toContain('42°C');
    expect(lives.map((el) => el.textContent)).toContain('17%');
  });

  it('when it cannot be read it says so (not 0 — "no value" and "zero" are two different things)', async () => {
    installCockpit('ALIENTEK ATK-DLRK3588', {
      'temp.soc': undefined,
      'temp.soc__status': 'unavailable',
    });
    await loadCard();
    const lives = [...document.querySelectorAll('.hw__live')];
    expect(lives.map((el) => el.textContent).join(' ')).toMatch(/读不到/);
  });
});

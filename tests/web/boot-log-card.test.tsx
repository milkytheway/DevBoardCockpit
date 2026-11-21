import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { waitFor } from '@testing-library/react';

/**
 * The "boot log" card (`cards/boot-log/card.js`).
 *
 * ── What it has to do ──
 *
 * → **Run the flow** ✓ (`boot-log.capture` ✓) — the card is the button ✓.
 * → **Show what every step said** ✓ (the verdict of each step ✓) — the
 *   same shape as the workflow card ✓.
 * → **Say where the log lands** ✓ — the card may not see the output of a
 *   workflow ✓ (contract `05` §8·B·B5 ✓) → the log is a **file on the
 *   board** ✓ → the file transfer fetches it ✓.
 */
const REPO_ROOT = resolve(__dirname, '../..');
const CARD_DIR = join(REPO_ROOT, 'cards', 'boot-log');

const FLOWS = [
  {
    id: 'boot-log.capture',
    name: 'Boot log',
    version: '1.0.0',
    inputs: { path: { type: 'path', required: false, default: '/userdata/boot.log' } },
  },
];

/** Install a fake host API ✓ */
function installCockpit(overrides: Record<string, unknown> = {}): {
  run: ReturnType<typeof vi.fn>;
} {
  const run = vi.fn(async () => ({ ok: true, runId: 'wf-1' }));
  (window as unknown as { cockpit: unknown }).cockpit = {
    workflows: {
      list: async () => FLOWS,
      run,
      status: async () => ({
        ok: true,
        state: 'done',
        current: null,
        stages: [
          { stepId: 'capture', kind: 'exec', ok: true, verified: true },
          { stepId: 'store', kind: 'exec', ok: true, verified: true },
          { stepId: 'assert-not-empty', kind: 'assert', ok: true, verified: true },
        ],
      }),
      ...(overrides['workflows'] as Record<string, unknown> | undefined),
    },
  };
  return { run };
}

function mountCard(): void {
  const html = readFileSync(join(CARD_DIR, 'index.html'), 'utf8');
  const body = /<body>([\s\S]*)<\/body>/.exec(html);
  document.body.innerHTML = (body?.[1] ?? '').replace(/<script[\s\S]*?<\/script>/g, '');
}

let loaded: Promise<unknown> | null = null;
async function loadCard(): Promise<void> {
  if (loaded === null) loaded = import('../../cards/boot-log/card.js');
  await loaded;
}

beforeEach(() => {
  mountCard();
  vi.resetModules();
  loaded = null;
});

describe('the "boot log" card', () => {
  it('the button and the place where the log lands are there', async () => {
    installCockpit();
    await loadCard();
    expect(document.getElementById('run')).not.toBeNull();
    // → **The path comes from the flow's default** ✓ (the card does not
    //   invent it ✓).
    await waitFor(() =>
      expect(document.getElementById('path')?.textContent).toBe('/userdata/boot.log'),
    );
  });

  it('clicking the button runs the flow', async () => {
    const { run } = installCockpit();
    await loadCard();
    (document.getElementById('run') as HTMLButtonElement).click();
    await waitFor(() => expect(run).toHaveBeenCalledWith('boot-log.capture', {}));
  });

  it('the verdict of every step is shown', async () => {
    installCockpit();
    await loadCard();
    (document.getElementById('run') as HTMLButtonElement).click();
    await waitFor(() => expect(document.querySelectorAll('.log__step').length).toBe(3));
    const steps = [...document.querySelectorAll('.log__step')].map((el) => el.textContent);
    expect(steps[0]).toContain('capture');
    expect(steps[2]).toContain('assert-not-empty');
  });

  it('a refusal is reported as a refusal (the card must not pretend it ran)', async () => {
    installCockpit({
      workflows: {
        list: async () => FLOWS,
        run: async () => ({ ok: false, reason: 'denied' }),
        status: async () => ({ ok: true, state: 'done', current: null, stages: [] }),
      },
    });
    await loadCard();
    (document.getElementById('run') as HTMLButtonElement).click();
    // → **The card's wording** ✓ — it is Chinese ✓ (the `zh-Hans` half ✓
    //   of the card's own text ✓) → the test pins it ✓.
    await waitFor(() => expect(document.getElementById('note')?.textContent).toContain('没有被授权'));
  });
});

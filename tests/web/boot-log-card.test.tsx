import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { waitFor } from '@testing-library/react';

const REPO_ROOT = resolve(__dirname, '../..');
const CARD_DIR = join(REPO_ROOT, 'cards', 'boot-log');
const LOG_TEXT = [
  '[    0.000000] Booting Linux on physical CPU 0x0000000000',
  '[    1.502010] rk3588-pinctrl ff770000.pinctrl: probe success',
].join('\n');
const HOST_PATH = 'C:\\Users\\me\\AppData\\Local\\DevBoardCockpit\\boot-logs\\boot.log';

function installCockpit(): {
  capture: ReturnType<typeof vi.fn>;
  latest: ReturnType<typeof vi.fn>;
} {
  const capture = vi.fn(async () => ({
    ok: true,
    text: LOG_TEXT,
    // → **The host path is not in the card's answer** ✓ (the host narrows it
    //   ✓ — `narrowBootLog` ✓).
    capturedAt: '2026-11-21T12:00:00.000Z',
    bytes: LOG_TEXT.length,
    durationMs: 22_000,
    complete: true,
  }));
  const latest = vi.fn(async () => null);
  (window as unknown as { cockpit: unknown }).cockpit = {
    bootLog: { capture, latest },
  };
  return { capture, latest };
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
  window.history.replaceState({}, '', '/');
  mountCard();
  vi.resetModules();
  loaded = null;
});

describe('the "boot log" card', () => {
  it('has one explicit read action and a local log viewport', async () => {
    installCockpit();
    await loadCard();
    expect(document.getElementById('run')?.textContent).toBe(
      '\u83b7\u53d6\u542f\u52a8\u65e5\u5fd7',
    );
    expect(document.getElementById('log-output')).not.toBeNull();
    expect(document.body.textContent).not.toContain('/userdata/boot.log');
  });

  it('captures the complete serial boot log on the host', async () => {
    const { capture } = installCockpit();
    await loadCard();
    (document.getElementById('run') as HTMLButtonElement).click();

    await waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(document.getElementById('log-output')?.textContent).toContain('Booting Linux'),
    );
    expect((document.getElementById('log-dialog') as HTMLElement).hidden).toBe(false);
    // → **The card does not get the path of the host** ✓ (the contract says a
    //   card does not get the paths of the host ✓) → it shows **when** the
    //   capture happened ✓.
    expect(document.body.textContent).not.toContain('boot.log');
    expect(document.getElementById('host-path')?.textContent).toContain('2026-11-21');
  });

  it('reopens the latest log in the dialog instead of fetching again', async () => {
    const { capture, latest } = installCockpit();
    latest.mockResolvedValue({
      ok: true,
      text: LOG_TEXT,
      hostPath: HOST_PATH,
      capturedAt: '2026-11-21T12:00:00.000Z',
      bytes: LOG_TEXT.length,
      durationMs: 120,
      complete: true,
    });
    await loadCard();
    await waitFor(() =>
      expect(document.getElementById('run')?.textContent).toBe(
        '\u6253\u5f00\u65e5\u5fd7',
      ),
    );
    (document.getElementById('run') as HTMLButtonElement).click();
    expect((document.getElementById('log-dialog') as HTMLElement).hidden).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });

  it('supports selecting the complete log text for copying', async () => {
    const { capture } = installCockpit();
    await loadCard();
    (document.getElementById('run') as HTMLButtonElement).click();
    await waitFor(() => expect(capture).toHaveBeenCalled());
    (document.getElementById('select-all') as HTMLButtonElement).click();
    expect(window.getSelection()?.toString()).toContain('Booting Linux');
  });

  it('shows copy feedback inside the open log dialog', async () => {
    const { capture } = installCockpit();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    await loadCard();
    (document.getElementById('run') as HTMLButtonElement).click();
    await waitFor(() => expect(capture).toHaveBeenCalled());
    (document.getElementById('copy') as HTMLButtonElement).click();
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(LOG_TEXT));
    await waitFor(() =>
      expect(document.getElementById('copy')?.textContent).toBe('\u5df2\u590d\u5236'),
    );
  });

  it('uses English wording when the host supplies the English locale', async () => {
    window.history.replaceState({}, '', '/?lang=en');
    installCockpit();
    await loadCard();
    expect(document.getElementById('log-title')?.textContent).toBe('Boot log');
    expect(document.getElementById('run')?.textContent).toBe('Get boot log');
    expect(document.getElementById('search')?.getAttribute('placeholder')).toBe('Filter log');
    expect(document.getElementById('select-all')?.textContent).toBe('Select all');
    expect(document.getElementById('copy')?.textContent).toBe('Copy');
  });

  it('shows the latest host-side log immediately when the card opens', async () => {
    const { latest } = installCockpit();
    latest.mockResolvedValue({
      ok: true,
      text: LOG_TEXT,
      hostPath: HOST_PATH,
      capturedAt: '2026-11-21T12:00:00.000Z',
      bytes: LOG_TEXT.length,
      durationMs: 22_000,
      complete: true,
    });
    await loadCard();
    await waitFor(() =>
      expect(document.getElementById('log-output')?.textContent).toContain('Booting Linux'),
    );
  });

  it('shows the host failure reason when the serial capture cannot start', async () => {
    const { capture } = installCockpit();
    capture.mockResolvedValue({ ok: false, reason: 'serial_busy' });
    await loadCard();
    (document.getElementById('run') as HTMLButtonElement).click();
    await waitFor(() =>
      expect(document.getElementById('note')?.textContent).toBe(
        '\u4e32\u53e3\u5df2\u88ab\u5360\u7528',
      ),
    );
  });

  it('the old ADB dmesg workflow is not part of the card path', () => {
    const source = readFileSync(join(CARD_DIR, 'card.js'), 'utf8');
    expect(source).not.toContain('workflows.run');
    expect(source).not.toContain("'boot_log'");
  });
});

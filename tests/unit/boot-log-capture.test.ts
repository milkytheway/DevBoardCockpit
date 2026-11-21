import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import {
  BootLogCapture,
  trimSerialBootLog,
  type BootLogCaptureOptions,
} from '../../src/main/boot-log/capture';
import type { Connection } from '../../src/main/hal/connection';
import type { ConnectionProfile } from '../../src/main/profiles/schema';

const BOARD = 'ATK-DLRK3588';

function profile(
  id: string,
  transport: 'serial' | 'adb',
  options: Record<string, unknown>,
): ConnectionProfile {
  return {
    id,
    label: id,
    transport,
    board_pack: 'rk3588-atk',
    device_key: BOARD,
    options,
  };
}

function harness(root: string, captured: string) {
  const close = vi.fn(async () => undefined);
  const exec = vi.fn(async (_command: string) => ({
    exitCode: 0,
    stdout: captured,
    stderr: '',
    durationMs: 20,
    timedOut: false,
  }));
  const connection = {
    id: 'serial',
    transport: 'serial',
    capabilities: () => ({ exec: true, pty: true, files: false, exitCode: false }),
    open: async () => undefined,
    close,
    exec,
    pull: vi.fn(),
    push: vi.fn(),
    list: vi.fn(),
    openSession: vi.fn(),
  } as unknown as Connection;
  const options: BootLogCaptureOptions = {
    listProfiles: () => [
      profile('serial', 'serial', { port: 'COM3', baudrate: 1500000 }),
      profile('adb', 'adb', { serial: 'board-serial' }),
    ],
    currentDeviceKey: () => BOARD,
    createConnection: async () => connection,
    outputDir: root,
  };
  return { options, close, exec };
}

describe('the serial boot-log reader', () => {
  it('keeps the newest boot section instead of the previous boot', () => {
    const text = [
      'kernel: [    0.000000] old boot',
      'Booting Linux old',
      'kernel: [   19.000000] old end',
      'kernel: [    0.000000] current boot',
      '[    1.580628] Booting Linux on physical CPU 0',
      'root@ATK-DLRK3588:/#',
    ].join('\n');
    expect(trimSerialBootLog(text)).toBe(
      [
        'kernel: [    0.000000] current boot',
        '[    1.580628] Booting Linux on physical CPU 0',
        'root@ATK-DLRK3588:/#',
      ].join('\n'),
    );
  });

  it('reads the persistent boot log through the serial connection and writes it on the host', async () => {
    const root = mkdtempSync(join(tmpdir(), 'boot-log-'));
    try {
      const log = [
        'kernel: [    0.000000] current boot',
        '[    1.580628] Booting Linux on physical CPU 0',
        '[    8.000000] usb ready',
        'root@ATK-DLRK3588:/#',
      ].join('\n');
      const h = harness(root, log);
      const result = await new BootLogCapture(h.options).capture();

      expect(result.complete).toBe(true);
      expect(result.text.startsWith('kernel:')).toBe(true);
      expect(result.hostPath).toContain('boot-logs');
      expect(h.exec).toHaveBeenCalledWith(
        'cat /var/log/messages.0 2>/dev/null; cat /var/log/messages 2>/dev/null',
        expect.anything(),
      );
      expect(String(h.exec.mock.calls[0]?.[0])).not.toContain('reboot');
      expect(h.close).toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('latest reads the most recent host-side capture', async () => {
    const root = mkdtempSync(join(tmpdir(), 'boot-log-'));
    try {
      const h = harness(root, 'kernel: [    0.000000] boot\nBooting Linux\nroot@board:/#');
      const service = new BootLogCapture(h.options);
      await service.capture();
      const latest = await service.latest();
      expect(latest?.text).toContain('Booting Linux');
      expect(latest?.hostPath).toContain('boot-logs');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the shipped workflow is serial and read-only', () => {
    const source = readFileSync(
      join(__dirname, '../../profiles/workflows/boot-log.capture.yaml'),
      'utf8',
    );
    const pack = load(source) as {
      roles?: Record<string, { profile?: string }>;
      steps?: { cmd?: string; readback?: { command?: string } }[];
    };
    expect(pack.roles?.['target']?.profile).toBe('board-serial');
    expect(JSON.stringify(pack)).not.toMatch(/\breboot\b/i);
    expect(JSON.stringify(pack)).not.toMatch(/\bdmesg\b/i);
    expect(pack.steps?.[0]?.cmd).toContain('/var/log/messages');
  });
});

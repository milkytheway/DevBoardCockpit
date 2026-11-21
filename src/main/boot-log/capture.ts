import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Connection } from '../hal/connection';
import type { ConnectionProfile } from '../profiles/schema';
import { deviceKeyOf } from '../profiles/schema';

export interface BootLogCaptureResult {
  ok: true;
  text: string;
  hostPath: string;
  capturedAt: string;
  bytes: number;
  durationMs: number;
  complete: boolean;
}

export interface BootLogCaptureOptions {
  listProfiles(): ConnectionProfile[];
  currentDeviceKey(): string | null;
  createConnection(profile: ConnectionProfile): Promise<Connection>;
  outputDir: string;
  now?: () => number;
  syntheticForDevice?: (deviceKey: string) => string | null;
}

const BOOT_MARK = /kernel:\s*\[\s+0\.000000\]|Booting Linux/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Persistent syslog contains earlier boots as well. Keep the newest kernel
 * boot section, starting from its 0.000000 line when that line survived.
 */
export function trimSerialBootLog(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const boot = normalized.lastIndexOf('Booting Linux');
  if (boot < 0) return normalized.trim();
  const beforeBoot = normalized.slice(0, boot);
  const zeroPattern = /kernel:\s*\[\s+0\.000000\]/g;
  let zeroAt = -1;
  for (const match of beforeBoot.matchAll(zeroPattern)) {
    zeroAt = match.index ?? zeroAt;
  }
  const start = zeroAt >= 0 ? zeroAt : boot;
  return normalized.slice(normalized.lastIndexOf('\n', start) + 1).trim();
}

function fileName(at: number): string {
  return `boot-${new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.log`;
}

export class BootLogCapture {
  private active = false;
  private readonly now: () => number;

  constructor(private readonly opts: BootLogCaptureOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  async capture(): Promise<BootLogCaptureResult> {
    if (this.active) throw new Error('boot_log_busy');
    this.active = true;
    const startedAt = this.now();
    try {
      const key = this.opts.currentDeviceKey();
      if (key === null) throw new Error('board_not_connected');
      const synthetic = this.opts.syntheticForDevice?.(key) ?? null;
      if (synthetic !== null) {
        await sleep(180);
        return this.persist(trimSerialBootLog(synthetic), startedAt);
      }

      const serialProfile = this.opts
        .listProfiles()
        .find(
          (profile) =>
            deviceKeyOf(profile) === key && profile.transport === 'serial',
        );
      if (serialProfile === undefined) throw new Error('serial_not_configured');

      const connection = await this.opts.createConnection(serialProfile);
      try {
        await connection.open();
        const result = await connection.exec(
          'cat /var/log/messages.0 2>/dev/null; cat /var/log/messages 2>/dev/null',
          { timeoutMs: 30_000 },
        );
        const text = trimSerialBootLog(result.stdout);
        if (text.length === 0) throw new Error('boot_log_empty');
        return this.persist(text, startedAt);
      } finally {
        await connection.close().catch(() => undefined);
      }
    } finally {
      this.active = false;
    }
  }

  async latest(): Promise<BootLogCaptureResult | null> {
    const dir = join(this.opts.outputDir, 'boot-logs');
    let files: string[];
    try {
      files = readdirSync(dir)
        .filter((name) => name.endsWith('.log'))
        .map((name) => join(dir, name));
    } catch {
      return null;
    }
    if (files.length === 0) return null;
    files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    const hostPath = files[0];
    if (hostPath === undefined) return null;
    const text = readFileSync(hostPath, 'utf8');
    return {
      ok: true,
      text,
      hostPath,
      capturedAt: statSync(hostPath).mtime.toISOString(),
      bytes: Buffer.byteLength(text, 'utf8'),
      durationMs: 0,
      complete: BOOT_MARK.test(text),
    };
  }

  private persist(text: string, startedAt: number): BootLogCaptureResult {
    const dir = join(this.opts.outputDir, 'boot-logs');
    mkdirSync(dir, { recursive: true });
    const capturedAt = this.now();
    const hostPath = join(dir, fileName(capturedAt));
    writeFileSync(hostPath, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
    return {
      ok: true,
      text,
      hostPath,
      capturedAt: new Date(capturedAt).toISOString(),
      bytes: Buffer.byteLength(text, 'utf8'),
      durationMs: capturedAt - startedAt,
      complete: BOOT_MARK.test(text),
    };
  }
}

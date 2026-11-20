import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeDiscoveryFile,
  removeDiscoveryFile,
  discoveryFilePath,
  type DiscoveryInfo,
} from '../../../src/main/mcp/discovery';

/**
 * Records the arguments of every `writeFileSync` call (cross-platform).
 *
 * Why `node:fs` is mocked:
 *   Windows has **no POSIX mode**, so the mode bits of `statSync().mode` are
 *   **always the default** there. The only thing that can be checked is
 *   **whether the intent "readable by the current user only" was expressed**,
 *   and that is the only place where this permission can be expressed at all
 *   (the actual permissions rely on the **ACL of the user data directory**).
 *
 * The mock replaces **the whole `node:fs`** (`importOriginal` covers the rest),
 *   so the implementation file (`src/main/mcp/discovery.ts`) **receives the same
 *   mock** and it is visible **whether the implementation wrote a mode**.
 */
const fsCalls = vi.hoisted(() => ({ writes: [] as Array<{ path: string; mode?: number }> }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    writeFileSync: (
      path: Parameters<typeof actual.writeFileSync>[0],
      data: Parameters<typeof actual.writeFileSync>[1],
      options?: Parameters<typeof actual.writeFileSync>[2],
    ) => {
      const opts = options as { mode?: number } | undefined;
      fsCalls.writes.push({ path: String(path), ...(opts?.mode === undefined ? {} : { mode: opts.mode }) });
      return actual.writeFileSync(path, data, options);
    },
  };
});

/**
 * The discovery file (contract `spec/04` §7.2).
 *
 * It is **the only coupling point between the agent and the GUI**.
 *
 * When the transport changes, the agent only has to change the way it reads
 * this file, so the file **has to be accurate**.
 *
 * Why the temporary file is written first and then renamed atomically:
 *
 * The agent may read **while the file is being written** → it reads half a
 * JSON → the parse fails → the agent thinks the GUI is not running → **it does
 * not retry** (the contract says explicitly: when it cannot connect it
 * **reports the error right away**, so that it does not reach another
 * process) → **a single truncated file makes the agent believe the service is
 * gone**.
 */
let dir: string;
let info: DiscoveryInfo;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cockpit-mcp-disc-'));
  info = {
    apiVersion: 'devboard/v1',
    transport: 'http',
    host: '127.0.0.1',
    port: 51234,
    pid: process.pid,
    token: 'tok-abc',
    cards_dir: join(dir, 'cards'),
    started_at: '2026-11-15T08:00:00.000Z',
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('MCP · the discovery file', () => {
  it('**the fields written out match the contract** (an agent connects by them)', () => {
    const path = discoveryFilePath(dir);
    writeDiscoveryFile(path, info);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(parsed['apiVersion']).toBe('devboard/v1');
    expect(parsed['transport']).toBe('http');
    expect(parsed['host']).toBe('127.0.0.1');
    expect(parsed['port']).toBe(51234);
    expect(parsed['pid']).toBe(process.pid);
    expect(parsed['token']).toBe('tok-abc');
    expect(parsed['cards_dir']).toBe(info.cards_dir);
    expect(typeof parsed['started_at']).toBe('string');
  });

  it('**half a file cannot be read while it is written** (a temporary file is written first and then renamed atomically)', () => {
    const path = discoveryFilePath(dir);
    writeDiscoveryFile(path, info);
    // **no temporary file is left behind** (a rename is not a copy)
    const strays = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(strays).toEqual([]);
  });

  it('**readable by the current user only** (POSIX 0600, contract §7.2)', () => {
    const path = discoveryFilePath(dir);
    writeDiscoveryFile(path, info);
    const mode = statSync(path).mode & 0o777;
    // Windows has no POSIX mode → there the **ACL of the user data directory
// itself** applies
    // → **this one only holds on POSIX** (on Windows it is empty, which is why
// there is another one below)
    if (process.platform !== 'win32') {
      expect(mode).toBe(0o600);
    }
  });

  it('**readable by the current user only**: the write has to carry `mode: 0o600` (**checked on both platforms**)', () => {
    // On Windows `mode` is largely ignored → the actual permissions there rely on
// the **ACL of the user data directory**
    // → so on Windows the **only thing that can be checked is whether the intent
// was expressed**
    // → and "forgetting to pin the permissions" is exactly what this contract
// prevents.
    fsCalls.writes.length = 0;
    writeDiscoveryFile(discoveryFilePath(dir), info);
    const call = fsCalls.writes.find((c) => c.path.endsWith('.tmp'));
    expect(call, 'no temporary file was written').toBeTruthy();
    expect(call?.mode, 'the write carried no mode → the permissions are the default ones (another user on the same machine can read the token)').toBe(0o600);
  });

  it('**once it is deleted it is gone** (the GUI cleans it up on exit)', () => {
    const path = discoveryFilePath(dir);
    writeDiscoveryFile(path, info);
    expect(existsSync(path)).toBe(true);
    removeDiscoveryFile(path);
    expect(existsSync(path)).toBe(false);
  });

  it('**deleting a file that does not exist does not crash** (the exit path may not hang on it)', () => {
    expect(() => removeDiscoveryFile(discoveryFilePath(dir))).not.toThrow();
  });

  it('**the file is in the user data directory** (the path of contract §7.2)', () => {
    expect(discoveryFilePath(dir).endsWith('mcp.json')).toBe(true);
  });
});

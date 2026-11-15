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
 * **记下 `writeFileSync` 的调用参数** ✓（跨平台 ✓）。
 *
 * → **为什么要 mock 掉 `node:fs`** ✓：
 *   Windows 上**没有 POSIX 模式** ✓（`statSync().mode` 那一位在那边**恒为默认值** ✓）
 *   → 那里唯一能断的只有「**有没有表达「仅当前用户可读」这个意图**」✓
 *   → 而那正是**权限这件事唯一能表达的地方** ✓（实际权限靠**用户数据目录的 ACL** ✓）。
 *
 * → **mock 的是整个 `node:fs`** ✓（`importOriginal` 兜住其余的 ✓）
 *   → 实现文件（`src/main/mcp/discovery.ts`）**也拿到同一个 mock** ✓
 *   → 所以「实现写没带 mode」**看得到** ✓。
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
 * **发现文件**（契约 `spec/04` §7.2 ✓）。
 *
 * ── 它是 agent 与 GUI 之间**唯一的耦合点** ✓ ──
 *
 * 换了传输方式，agent 只需要改读文件的方式 ✓ —— 所以这个文件**必须准** ✓。
 *
 * ── 为什么要「先写临时文件再原子改名」 ──
 *
 * agent 可能在**写入的过程中**来读 ✓ → 读到半个 JSON ✓ → 解析失败 ✓
 * → agent 以为 GUI 没起来 ✓ → **它不会重试** ✓（契约明写：连不上就**直接报错** ✓，
 * 避免连到别的进程 ✓）→ **一次半截文件就让 agent 以为服务没了** ✗。
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

describe('MCP · 发现文件', () => {
  it('**写出来的字段与契约一致** ✓（agent 照着它连 ✓）', () => {
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

  it('**写的过程里读不到半个文件** ✓（先写 .tmp 再原子改名 ✓）', () => {
    const path = discoveryFilePath(dir);
    writeDiscoveryFile(path, info);
    // **不留临时文件** ✓（改名不是复制 ✓）
    const strays = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(strays).toEqual([]);
  });

  it('**权限仅当前用户可读**（POSIX 0600 ✓ —— 契约 §7.2 ✓）', () => {
    const path = discoveryFilePath(dir);
    writeDiscoveryFile(path, info);
    const mode = statSync(path).mode & 0o777;
    // ⚠️ Windows 上没有 POSIX 模式 ✓ → 那里靠用户数据目录**本身的 ACL** ✓
    // → **这一条在 POSIX 上才有效** ✓（Windows 上它是空的 ✓ → 所以另有下面一条 ✓）
    if (process.platform !== 'win32') {
      expect(mode).toBe(0o600);
    }
  });

  it('**权限仅当前用户可读**：写的时候必须带上 `mode: 0o600`（**两个平台都断** ✓）', () => {
    // ⚠️ Windows 上 `mode` 基本被忽略 ✓ → 那边的实际权限靠**用户数据目录的 ACL** ✓
    // → 所以在 Windows 上**唯一能断的就是「有没有表达这个意图」** ✓
    // → 而「忘了钉权限」正是这条契约要防的事 ✓。
    fsCalls.writes.length = 0;
    writeDiscoveryFile(discoveryFilePath(dir), info);
    const call = fsCalls.writes.find((c) => c.path.endsWith('.tmp'));
    expect(call, '没有写临时文件').toBeTruthy();
    expect(call?.mode, '写入时没有带 mode → 权限是默认的（同机别的用户读得到 token）').toBe(0o600);
  });

  it('**删掉之后就没有了** ✓（GUI 退出时清理 ✓）', () => {
    const path = discoveryFilePath(dir);
    writeDiscoveryFile(path, info);
    expect(existsSync(path)).toBe(true);
    removeDiscoveryFile(path);
    expect(existsSync(path)).toBe(false);
  });

  it('**删一个不存在的文件不炸** ✓（退出流程不能因为它挂 ✓）', () => {
    expect(() => removeDiscoveryFile(discoveryFilePath(dir))).not.toThrow();
  });

  it('**文件在用户数据目录里** ✓（契约 §7.2 的路径 ✓）', () => {
    expect(discoveryFilePath(dir).endsWith('mcp.json')).toBe(true);
  });
});

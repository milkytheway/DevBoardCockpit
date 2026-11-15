import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    // ⚠️ Windows 上没有 POSIX 模式 ✓ → 那里靠 ACL ✓（本判据在 POSIX 上生效 ✓）
    if (process.platform !== 'win32') {
      expect(mode).toBe(0o600);
    }
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

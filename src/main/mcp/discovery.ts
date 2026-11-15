import { chmodSync, existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **发现文件**（契约 `spec/04` §7.2 ✓）。
 *
 * ── 它是什么 ──
 *
 * agent 怎么知道端口和 token？**读这个文件** ✓。
 * → 它是 agent 与 GUI 之间**唯一的耦合点** ✓（契约原话 ✓）。
 * → 换了传输方式，agent 只需要改读文件的方式 ✓。
 *
 * ── 它的字段（契约 §7.2 抄下来 ✓）──
 *
 * ```json
 * { "apiVersion": "devboard/v1", "transport": "http", "host": "127.0.0.1",
 *   "port": 51234, "pid": 12345, "token": "…", "cards_dir": "…", "started_at": "…" }
 * ```
 */

/** 发现文件的内容（**字段照契约抄** ✓ —— 少一个字段，agent 就连不上 ✓） */
export interface DiscoveryInfo {
  apiVersion: string;
  transport: 'http';
  host: string;
  port: number;
  pid: number;
  /** 本次启动生成的 bearer token ✓（**每次重启都换** ✓） */
  token: string;
  /** 卡片目录（agent 要往这儿写卡 ✓ —— 契约 §三 ✓） */
  cards_dir: string;
  started_at: string;
}

/** 发现文件在**用户数据目录**里的路径（契约 §7.2 ✓） */
export function discoveryFilePath(dataDir: string): string {
  return join(dataDir, 'mcp.json');
}

/**
 * **写发现文件** ✓ —— 先写临时文件，再**原子改名** ✓。
 *
 * → **为什么不能直接写** ✓：agent 可能在写入过程中来读 ✓
 *   → 读到半个 JSON ✓ → 解析失败 ✓ → **agent 不会重试** ✓（契约：连不上就**直接报错** ✓）
 *   → **一次半截文件就让 agent 以为服务没了** ✗。
 * → **改名是原子的** ✓（同一个文件系统内 ✓）→ agent 要么读到旧的 ✓，要么读到新的 ✓，
 *   **不会读到半个** ✓。
 *
 * → **权限 0600** ✓（仅当前用户可读 ✓ —— 契约 §7.2 ✓）。
 *   Windows 上没有 POSIX 模式 ✓ → 那里靠用户数据目录**本身的 ACL** ✓
 *   （用户数据目录本来就只有当前用户能进 ✓）。
 */
export function writeDiscoveryFile(path: string, info: DiscoveryInfo): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  // **POSIX 上把权限钉死** ✓（umask 会改它 ✓ —— 0644 的话 token 就被同机别的用户读到了 ✗）
  if (process.platform !== 'win32') chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/**
 * **删发现文件** ✓（GUI 退出时 ✓ / 监听失败时也要删 ✓）。
 *
 * → **不能留一个指向死进程的发现文件** ✓（契约 §7.2 ✓）：
 *   agent 读到它 → 去连 → 连不上 → **它不重试别的端口** ✓（契约 ✓）
 *   → 直接报错 ✓ → **agent 以为 GUI 没起来** ✗ → 而其实 GUI 起来了只是端口变了 ✗。
 *
 * → **删一个不存在的文件不炸** ✓（退出流程不能因为它挂 ✓）。
 */
export function removeDiscoveryFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // **删不掉就算了** ✓（退出流程不该在这里断 ✓）
  }
}

/** 发现文件在不在（**诊断用** ✓） */
export function discoveryExists(path: string): boolean {
  return existsSync(path);
}

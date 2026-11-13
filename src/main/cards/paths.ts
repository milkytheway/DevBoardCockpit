import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';

/**
 * 卡片目录里的路径解析与**穿越防护**。
 *
 * ── 这是安全边界，不是工具函数 ──
 *
 * 卡片是 **AI 写的任意网页**。它能请求 `cockpit://card/<id>/<路径>`。
 * 路径没守住 = 卡片能读**宿主文件系统**。
 *
 * 要挡的：`..` · 绝对路径 · Windows 盘符 · `%2e%2e`（URL 编码过的 `..`）·
 * 目录（结尾 `/`）· 空路径。
 */

/**
 * 把相对路径解析到卡片目录里。
 *
 * @returns 越界就是 `null`（**不猜**——契约的「不猜」口径）
 */
export function resolveInsideCard(root: string, relPath: string): string | null {
  if (relPath === '') return null;

  // **先 decode**：浏览器给我们的路径可能已经编码过一遍
  let decoded: string;
  try {
    decoded = decodeURIComponent(relPath);
  } catch {
    return null; // 编码坏了的路径 → 不处理
  }
  if (decoded === '') return null;
  // 目录不是文件
  if (decoded.endsWith('/') || decoded.endsWith('\\')) return null;

  // 绝对路径（POSIX 的 `/` 与 Windows 的 `C:\`）一律不认
  if (decoded.startsWith('/') || decoded.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(decoded)) {
    return null;
  }

  const base = resolve(root);
  const full = resolve(base, decoded);
  // **判据不是字符串比较**：是「解出来的路径还在 base 底下吗」
  if (full !== base && !full.startsWith(base + sep)) return null;

  // ── 符号链接 ──
  //
  // 上面的判据是**词法**的：软链在词法上「在目录里」，
  // 指向的却可能在**目录之外**（软链是最常见的绕过）。
  //
  // → 对**真实路径**再判一次。
  const realBase = realpathOrNull(base);
  if (realBase === null) {
    // 根目录自己都不存在 → 里面不可能有文件可读（404 即可）
    return full;
  }
  const realFull = realpathOrNull(full);
  if (realFull !== null) {
    // 文件存在 → 判它**真实**的位置
    if (!isInside(realBase, realFull)) return null;
    return full;
  }
  // 文件不存在 → 判它的**上一级**（上一级可能是软链）
  const realParent = realpathOrNull(dirname(full));
  if (realParent !== null && !isInside(realBase, realParent)) return null;
  return full;
}

/** 真实路径（解析软链）；不存在就是 null */
function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** `child` 是不是在 `base` 底下（**不含 base 自己**） */
function isInside(base: string, child: string): boolean {
  if (child === base) return true;
  return child.startsWith(base + sep);
}

const MIME_BY_EXT: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** 按扩展名给 MIME。**不认识的给二进制**（不猜） */
export function mimeFor(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** 文件在不在、是不是文件（目录不算） */
export function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 读一个文件（不存在就是 null） */
export function readFileOrNull(path: string): Buffer | null {
  try {
    return isFile(path) ? readFileSync(path) : null;
  } catch {
    return null;
  }
}

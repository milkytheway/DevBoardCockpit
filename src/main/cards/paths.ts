import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';

/**
 * Path resolution and **traversal protection** inside a card directory.
 *
 * ── This is a security boundary, not a utility function ──
 *
 * A card is **an arbitrary web page written by an AI**. It can request
 * `cockpit://card/<id>/<path>`.
 * A path that is not held back = the card can read the **host file system**.
 *
 * What has to be blocked: `..` · absolute paths · Windows drive letters ·
 * `%2e%2e` (a URL-encoded `..`) · directories (a trailing `/`) · an empty
 * path.
 */

/**
 * Resolves a relative path inside the card directory.
 *
 * @returns `null` when it leaves the directory (**no guessing** — the
 * contract's "do not guess" stance)
 */
export function resolveInsideCard(root: string, relPath: string): string | null {
  if (relPath === '') return null;

  // **Decode first**: the path the browser hands us may already be encoded
  let decoded: string;
  try {
    decoded = decodeURIComponent(relPath);
  } catch {
    return null; // A path with a broken encoding is left alone
  }
  if (decoded === '') return null;
  // A directory is not a file
  if (decoded.endsWith('/') || decoded.endsWith('\\')) return null;

  // An absolute path (the POSIX `/` and the Windows `C:\`) is never accepted
  if (decoded.startsWith('/') || decoded.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(decoded)) {
    return null;
  }

  const base = resolve(root);
  const full = resolve(base, decoded);
  // **The criterion is not a string comparison**: it is "is the resolved path still below the base"
  if (full !== base && !full.startsWith(base + sep)) return null;

  // ── Symbolic links ──
  //
  // The criterion above is **lexical**: a symbolic link is lexically "inside the directory",
  // but what it points at may be **outside of it** (a symbolic link is the most common way around).
  //
  // → Judge the **real path** as well.
  const realBase = realpathOrNull(base);
  if (realBase === null) {
    // The root directory itself does not exist → there can be no readable file inside it (404 is enough)
    return full;
  }
  const realFull = realpathOrNull(full);
  if (realFull !== null) {
    // The file exists → judge its **real** location
    if (!isInside(realBase, realFull)) return null;
    return full;
  }
  // The file does not exist → judge its **parent** (the parent may be a symbolic link)
  const realParent = realpathOrNull(dirname(full));
  if (realParent !== null && !isInside(realBase, realParent)) return null;
  return full;
}

/** The real path (the symbolic links resolved); `null` when it does not exist */
function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Is `child` below `base` (**not** `base` itself) */
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

/** The MIME type by extension. **An unknown extension is binary** (no guessing) */
export function mimeFor(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Does the file exist, and is it a file (a directory does not count) */
export function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Reads a file (`null` when it does not exist) */
export function readFileOrNull(path: string): Buffer | null {
  try {
    return isFile(path) ? readFileSync(path) : null;
  } catch {
    return null;
  }
}

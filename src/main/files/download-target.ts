import { basename, extname, join } from 'node:path';

/**
 * The default place a download is written to.
 *
 * **Why the host decides it**: the renderer only knows the remote path, not
 * where it belongs on the host.
 * Earlier the renderer passed an empty string and the comment of the host said
 * "the host uses its default destination" — and that "default destination"
 * **did not exist at all**,
 * so `adb pull <remote> ''` / `sftp.fastGet(remote, '')` / `copyFile(remote, '')`
 * always failed.
 *
 * So: **the host decides the place and hands the decided path back to the
 * renderer**, so that the interface can tell the user "saved to …".
 */

/** The characters that are not allowed in a Windows file name, plus the control characters */
// eslint-disable-next-line no-control-regex
const INVALID = /[<>:"/\\|?*\u0000-\u001f]/g;

/**
 * The reserved device names of Windows.
 *
 * **The ones with an extension are devices as well**: `con.txt` / `nul.log` /
 * `COM1.tar` are device names on Windows too, and writing to them fails
 * (`ERROR_INVALID_NAME`) — an error message that means nothing to the user.
 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Turns a remote file name into a name that can land on Windows.
 *
 * The remote path is **external input** (in the future both the cards and the
 * MCP can pass it), and the destination is on the file system of the host — so
 * the path traversal and the illegal characters have to be blocked here.
 */
export function sanitizeFileName(name: string): string {
  let out = name.replace(INVALID, '_').trim();
  // Windows silently drops a trailing dot or space — that turns "a.txt." into "a.txt",
  // and two downloads then overwrite the same file. They are cut off directly.
  out = out.replace(/[. ]+$/, '');
  if (out.length === 0) out = 'download';
  if (RESERVED.test(out)) out = `_${out}`;
  return out;
}

/**
 * The default destination path of a download = the download directory + the
 * remote file name.
 *
 * @param downloadsDir the download directory of the host (`app.getPath('downloads')`)
 * @param remotePath   the remote path
 */
export function defaultDownloadPath(downloadsDir: string, remotePath: string): string {
  return join(downloadsDir, sanitizeFileName(basename(remotePath)));
}

/**
 * The destination path of a download, **with another name when it collides**
 * (`a.txt` → `a-1.txt` → `a-2.txt`).
 *
 * Overwriting silently is a data safety problem: the user pulls three files
 * with the same name from the board, the result of the first two is covered by
 * the third, and he is not given a single hint.
 */
export function uniqueDownloadPath(
  downloadsDir: string,
  remotePath: string,
  exists: (path: string) => boolean,
): string {
  const name = sanitizeFileName(basename(remotePath));
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const first = join(downloadsDir, name);
  if (!exists(first)) return first;
  for (let i = 1; i < 1000; i += 1) {
    const candidate = join(downloadsDir, `${stem}-${i}${ext}`);
    if (!exists(candidate)) return candidate;
  }
  return join(downloadsDir, `${stem}-${Date.now()}${ext}`);
}

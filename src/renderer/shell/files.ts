/**
 * File transfer: the two directions, as functions.
 *
 * ── why they are not inline in the shell ──
 *
 * The upload has one rule that matters: **the host gets an absolute path**,
 * not a file name. A file name would make the host look for a same-named
 * file in its own working directory — and silently transfer a *different*
 * file. That rule has to be testable, so it lives here rather than inside
 * a JSX callback.
 */

export interface FileTransferHost {
  /** The host's absolute path for a picked file (`preload.getPathForFile`). */
  getPathForFile: (file: File) => string;
  /** Upload: local file → remote directory. */
  push: (sessionId: string, localPath: string, remotePath: string) => Promise<unknown>;
  /** Download: remote file → the host picks where it lands. */
  pull: (connectionId: string, remotePath: string) => Promise<{ localPath: string }>;
}

/**
 * Upload a file to a remote directory.
 *
 * @returns The host's absolute path that was used (for the log).
 */
export async function uploadFile(
  host: FileTransferHost,
  sessionId: string,
  file: File,
  remotePath: string,
): Promise<string> {
  // **绝对路径**，不是文件名
  const localPath = host.getPathForFile(file);
  await host.push(sessionId, localPath, remotePath);
  return localPath;
}

/**
 * Download a remote file.
 *
 * @returns Where the host put it.
 */
export async function downloadFile(
  host: FileTransferHost,
  connectionId: string,
  remotePath: string,
): Promise<string> {
  const result = await host.pull(connectionId, remotePath);
  return result.localPath;
}

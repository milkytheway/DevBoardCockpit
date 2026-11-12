import { basename, join } from 'node:path';

/**
 * 下载的默认落盘位置。
 *
 * **为什么宿主定**：renderer 只知道远端路径，不知道宿主上该放哪。
 * 早先 renderer 传空串，宿主的注释写着「宿主用它的默认落盘位置」——
 * 而那个「默认落盘位置」**根本不存在**，
 * 于是 `adb pull <remote> ''` / `sftp.fastGet(remote, '')` / `copyFile(remote, '')` 必挂。
 *
 * 所以：**宿主定位置，并把定好的路径回传给 renderer**，
 * 让界面能告诉用户「已保存到 …」。
 */

/** Windows 文件名里不能用的字符，外加控制字符 */
// eslint-disable-next-line no-control-regex
const INVALID = /[<>:"/\\|?*\u0000-\u001f]/g;

/** Windows 的保留设备名（不分扩展名） */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 把远端文件名收拾成一个能落在 Windows 上的名字。
 *
 * 远端路径是**外部输入**（将来卡片与 MCP 都能传参），
 * 而落盘位置在宿主文件系统上——所以这里必须挡住路径穿越与非法字符。
 */
export function sanitizeFileName(name: string): string {
  let out = name.replace(INVALID, '_').trim();
  // Windows 会悄悄去掉结尾的点和空格——那会让「a.txt.」变成「a.txt」，
  // 于是两次下载覆盖同一个文件。直接砍掉。
  out = out.replace(/[. ]+$/, '');
  if (out.length === 0) out = 'download';
  if (RESERVED.test(out)) out = `_${out}`;
  return out;
}

/**
 * 下载的默认落盘路径 = 下载目录 + 远端文件名。
 *
 * @param downloadsDir 宿主的下载目录（`app.getPath('downloads')`）
 * @param remotePath   远端路径
 */
export function defaultDownloadPath(downloadsDir: string, remotePath: string): string {
  return join(downloadsDir, sanitizeFileName(basename(remotePath)));
}

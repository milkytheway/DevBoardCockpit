/**
 * `ls -la` 输出解析。
 *
 * **为什么单独一个文件**：ADB 传输要靠它解析 `adb shell ls -la` 的回包，
 * 文件互传服务也要——同一个解析器只能有一份
 * （跟「核心词表只有一个源头」同一条道理）。
 *
 * 所以它放在 `util/`：既不属于 `hal/`（连接层），也不属于 `files/`（互传服务），
 * 两边都能用，且谁都不拥有它。
 */

/**
 * 解析 `ls -l` 的大小列。
 *
 * 管道下的 GNU ls 给原始字节数（`4096`），
 * 但有些环境给人类可读值（`4.0K`）——真机样本里就有 `drwxr-xr-x 6 root root 4.0K`。
 * 两种都要认。
 */
export function parseSize(text: string): number | null {
  const t = text.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(\d+(?:\.\d+)?)([KMGTP]?)$/i.exec(t);
  if (!m) return null;
  const units: Record<string, number> = {
    '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5,
  };
  const unit = (m[2] ?? '').toUpperCase();
  const factor = units[unit];
  if (factor === undefined) return null;
  return Math.round(Number(m[1]) * factor);
}

/**
 * `ls -la` 的时间格式是 `Nov 12 09:30` 或 `Nov 12  2024`——
 * **不带年份**，且这个格式 `Date` 解析不了。
 * 所以手工解析：补上当前年份，把月份名换成数字。
 * 解析不出来就返回 null——时间显示不出来不是致命问题，条目本身仍然有用。
 */
export function parseLsDate(text: string): string | null {
  const months: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  const m = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(?:(\d{1,2}):(\d{2})|(\d{4}))$/.exec(text.trim());
  if (!m) return null;
  const month = months[m[1]];
  if (month === undefined) return null;
  const day = Number(m[2]);
  // **按 UTC 解释远端的墙上时间**。
  //
  // 用本地时间构造再 `.toISOString()` 的话，在 UTC+8 下
  // 「Aug 27  2026」会变成 `2026-08-26T16:00:00.000Z`——
  // **日期差了一天**。而远端的时区我们根本不知道，
  // 所以最可预期的做法是：把它给的墙上时间当成 UTC 原样保留。
  const year = m[5] !== undefined ? Number(m[5]) : new Date().getUTCFullYear();
  if (m[3] !== undefined) {
    const d = new Date(Date.UTC(year, month, day, Number(m[3]), Number(m[4])));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(Date.UTC(year, month, day));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 解析出来的目录条目 */
export interface LsEntry {
  name: string;
  /** 首字符：d 目录、l 软链接、- 普通文件…… */
  type: string;
  size: number | null;
  modifiedAt: string | null;
}

/**
 * 解析 `ls -la` 的每一行。
 *
 * 只取名字、类型、大小、修改时间——够文件浏览器画树了。
 * 解析不了的行直接跳过：远端的 ls 输出格式各家不同，
 * 一行解析不了不该毁掉整次列举。
 *
 * **软链接**：`-rwxrwxrwx ... bin -> usr/bin/` 里的名字是 `bin`，
 * `-> usr/bin/` 是链接目标，**不是名字的一部分**。
 * 真机样本里就有这种行（`fixtures/session-log/serial-session.log`）。
 * 把箭头一起当名字，文件树里就会出现一个叫 `bin -> usr/bin/` 的条目，
 * 对它做传输时路径根本不存在。
 */
export function parseLsLines(stdout: string): LsEntry[] {
  const out: LsEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // -rw-r--r-- 1 root root  1234 Nov 12 09:30 name
    // 日期必须显式匹配（它内部有空格），剩下的才是文件名
    const m = /^([dlbcps-])([rwxstST-]{9})\s+\d+\s+\S+\s+\S+\s+(\S+)\s+(\w{3}\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4}))\s+(.+)$/.exec(
      trimmed,
    );
    if (!m) continue;
    const [, type, , size, date, rawName] = m;
    // 软链接：`name -> target` 只取 name
    const arrow = rawName.indexOf(' -> ');
    let name = arrow >= 0 ? rawName.slice(0, arrow) : rawName;
    // `ls -la` 给目录名加一个尾斜杠（`dev/`）——
    // 留着它，路径就会变成 `/root/dev/`，传输时多一个斜杠。
    if (type === 'd') name = name.replace(/\/+$/, '');
    if (name === '.' || name === '..' || name.length === 0) continue;
    out.push({
      name,
      type,
      size: parseSize(size),
      modifiedAt: parseLsDate(date),
    });
  }
  return out;
}

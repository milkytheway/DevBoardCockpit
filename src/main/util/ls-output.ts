/**
 * Parsing of `ls -la` output.
 *
 * Why it is a file of its own: ADB transfers rely on it to parse the reply
 * to `adb shell ls -la`, and the file transfer service needs it too — there
 * must be exactly one parser, for the same reason there is exactly one
 * source for the core vocabulary.
 *
 * That is why it lives in `util/`: it belongs neither to `hal/` (the
 * connection layer) nor to `files/` (the file transfer service). Both sides
 * can use it and neither side owns it.
 */

/**
 * Parses the size column of `ls -l`.
 *
 * Under a pipe GNU ls reports the raw byte count (`4096`), but some
 * environments report a human-readable value (`4.0K`) — the real-board
 * samples contain `drwxr-xr-x 6 root root 4.0K`. Both forms have to be
 * accepted.
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
 * The `ls -la` time format is `Nov 12 09:30` or `Nov 12  2024` — it carries
 * no year, and `Date` cannot parse this format. So it is parsed by hand:
 * fill in the current year and turn the month name into a number. When it
 * cannot be parsed, return null — an entry whose time cannot be shown is
 * still useful on its own.
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
  // The remote wall-clock time is interpreted as UTC.
  //
  // If it were built with the local time and then `.toISOString()`-ed, in
  // UTC+8 "Aug 27  2026" would become `2026-08-26T16:00:00.000Z` — a
  // whole day off. The remote time zone is simply not known to us, so the
  // most predictable approach is: keep the wall-clock time it handed us as
  // UTC, unchanged.
  const year = m[5] !== undefined ? Number(m[5]) : new Date().getUTCFullYear();
  if (m[3] !== undefined) {
    const d = new Date(Date.UTC(year, month, day, Number(m[3]), Number(m[4])));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(Date.UTC(year, month, day));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A parsed directory entry */
export interface LsEntry {
  name: string;
  /** The first character: d directory, l symlink, - regular file, ... */
  type: string;
  size: number | null;
  modifiedAt: string | null;
}

/**
 * Parses every line of `ls -la` output.
 *
 * Only the name, the type, the size and the modification time are taken —
 * enough for the file browser to draw its tree. Lines that cannot be parsed
 * are simply skipped: the `ls` output of a remote system differs between
 * implementations, and one unparsable line must not ruin the whole listing.
 *
 * Symlinks: in `-rwxrwxrwx ... bin -> usr/bin/` the name is `bin`, while
 * `-> usr/bin/` is the link target and not part of the name. The real-board
 * samples contain such lines (`fixtures/session-log/serial-session.log`).
 * Treating the arrow as part of the name would put an entry called
 * `bin -> usr/bin/` into the file tree, and the path would not exist at all
 * when a transfer was attempted on it.
 */
export function parseLsLines(stdout: string): LsEntry[] {
  const out: LsEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // -rw-r--r-- 1 root root  1234 Nov 12 09:30 name
    // The date has to be matched explicitly (it contains spaces); only what
    // follows is the file name
    const m = /^([dlbcps-])([rwxstST-]{9})\s+\d+\s+\S+\s+\S+\s+(\S+)\s+(\w{3}\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4}))\s+(.+)$/.exec(
      trimmed,
    );
    if (!m) continue;
    const [, type, , size, date, rawName] = m;
    // Symlink: for `name -> target` take only the name
    const arrow = rawName.indexOf(' -> ');
    let name = arrow >= 0 ? rawName.slice(0, arrow) : rawName;
    // `ls -la` appends a trailing slash to directory names (`dev/`) —
    // keeping it would turn the path into `/root/dev/`, with one extra
    // slash in the transfer.
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

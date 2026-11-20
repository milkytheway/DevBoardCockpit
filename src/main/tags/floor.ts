/**
 * The danger floor (contract `docs/spec/02-board-pack.md` sections 5.2 and
 * 5.2.1).
 *
 * ── What it is ──
 *
 * A pack declares `danger` itself. But an agent can write packs — and
 * without any other constraint a pack that declares `reboot` as `reversible`
 * would skip the user's confirmation, which makes the grading pointless.
 *
 * So there is a floor:
 *
 * > Some operations are always `destructive`, no matter what the pack
 * > declares.
 *
 * ── The matching rules (section 5.2.1) ──
 *
 * 1. The unit of matching is a single token of argv (not a substring);
 * 2. A hit needs the tokens to be equal — `upgrade_status.sh` does not hit
 *    `upgrade`;
 * 3. A prefix match is only allowed when the pattern ends with `*`
 *    (`flash*` hits `flash_uboot`);
 * 4. Path-like patterns are normalised first;
 * 5. The `dd` family needs the `dd` token plus a target argument that hits
 *    a block device path;
 * 6. The `rm -rf /` family needs `rm` plus `-rf`/`-fr` plus a normalised
 *    value equal to `/`;
 * 7. Not matching does not mean safe — a command outside the table follows
 *    the declaration of the pack, but a warning is recorded.
 */

/** The version of the current floor table. The `danger_floor_version` of a pack has to be it */
export const DANGER_FLOOR_VERSION = 1;

/** The floor table of v1 (the six entries of section 5.2) */
interface FloorEntry {
  /** The pattern. One with a `*` is a prefix match */
  pattern: string;
  /** What this entry blocks (for the reader) */
  why: string;
}

const FLOOR_ENTRIES: readonly FloorEntry[] = [
  { pattern: 'reboot', why: 'reboot' },
  { pattern: 'shutdown', why: 'shut down' },
  { pattern: 'poweroff', why: 'shut down' },
  { pattern: 'halt', why: 'halt' },
  { pattern: 'flash*', why: 'flash storage' },
  // `erase` / `burn` are exact matches: the contract gives no prefix example
  // for them, and `erase_cache` / `burn_count` are common harmless names —
  // a prefix match here produces false positives, it does not close a hole.
  { pattern: 'erase', why: 'erase storage' },
  { pattern: 'burn', why: 'burn storage' },
  { pattern: 'upgrade', why: 'upgrade' },
  // `mkfs*` and not `mkfs`: `mkfs.ext4` and `mkfs` are the same operation.
  // The table in contract section 5.2 writes `mkfs`, but the prefix rule of
  // section 5.2.1 (`flash*` hits `flash_uboot`) shows that a synonym with a
  // suffix counts as well — the floor is a lower bound, it may not have
  // holes. The contract table disagrees here; the user ruled that the
  // suffixed synonym counts.
  { pattern: 'mkfs*', why: 'format' },
];

/** The target paths of raw block devices (prefix match) */
const BLOCK_DEVICE_PATTERNS = ['/dev/mmcblk*', '/dev/sd*', '/dev/nvme*'];

/** The result of one match */
export interface FloorMatch {
  matched: boolean;
  /** The floor entry that was hit (for the reader). null when nothing hit */
  pattern: string | null;
  /** Why it is blocked (for the reader) */
  why: string | null;
}

const NO_MATCH: FloorMatch = { matched: false, pattern: null, why: null };

/**
 * Split a command into an argv sequence, following the shell lexics.
 *
 * No shell is executed, no variable is expanded and no glob is expanded (the
 * order of section 5.2.1: encode the arguments first → then split the argv
 * → then match the floor).
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let has = false;
  let quote: string | null = null;

  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) {
        tokens.push(cur);
        cur = '';
        has = false;
      }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) tokens.push(cur);
  return tokens;
}

/**
 * Path normalisation: expand `..`, collapse repeated `/`, drop a trailing
 * `/`.
 *
 * The floor compares paths (`/dev/mmcblk0` and `/dev/mmcblk0/` are the same
 * thing).
 */
export function normalizePath(path: string): string {
  const absolute = path.startsWith('/');
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  const joined = out.join('/');
  return absolute ? `/${joined}` : joined;
}

/**
 * The basename of a token (`/sbin/reboot` → `reboot`).
 *
 * Contract section 5.2.1 writes "the tokens are equal" — but nearly every
 * real call carries an absolute path (`/sbin/reboot`, `/usr/sbin/shutdown`),
 * and a literal implementation would leave the floor empty for the way
 * commands are really written. The contract table says "equal token"; the
 * user ruled that the base name is compared.
 */
function baseName(token: string): string {
  const parts = token.split('/');
  return parts[parts.length - 1] ?? token;
}

/** The match of a token against a pattern: equal, or a prefix match when the pattern has a `*` */
function matchesPattern(token: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    return token.startsWith(pattern.slice(0, -1));
  }
  if (token === pattern) return true;
  // The basename counts too (`/sbin/reboot` → `reboot`)
  return baseName(token) === pattern;
}

function isBlockDevice(path: string): boolean {
  const p = normalizePath(path);
  return BLOCK_DEVICE_PATTERNS.some((pat) => matchesPattern(p, pat));
}

/**
 * `dd` writing to a block device.
 *
 * The target argument is the value of `of=`, or the non-option argument
 * that follows it (section 5.2.1).
 */
function matchDd(tokens: string[]): FloorMatch | null {
  if (baseName(tokens[0] ?? '') !== 'dd') return null;
  let target: string | undefined;
  for (let i = 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.startsWith('of=')) {
      target = t.slice(3);
      break;
    }
    if (!t.startsWith('-') && !t.includes('=')) {
      target = t;
      break;
    }
  }
  if (target !== undefined && isBlockDevice(target)) {
    return { matched: true, pattern: `dd → ${target}`, why: 'write a raw block device' };
  }
  return null;
}

/**
 * `rm -rf /` and its equivalents.
 *
 * Flags written with separate letters count as well (`-rf` / `-fr` /
 * `-r -f`) — they say the same thing.
 */
function matchRmRoot(tokens: string[]): FloorMatch | null {
  if (baseName(tokens[0] ?? '') !== 'rm') return null;
  const flags = tokens
    .slice(1)
    .filter((t) => t.startsWith('-') && !t.includes('='))
    .join('');
  if (!flags.includes('r') || !flags.includes('f')) return null;
  for (const t of tokens.slice(1)) {
    if (t.startsWith('-')) continue;
    const p = normalizePath(t);
    // `/*` expands to every entry of the root directory — it is equivalent to `/`
    if (p === '/' || p === '/*') {
      return { matched: true, pattern: 'rm -rf /', why: 'delete the root' };
    }
  }
  return null;
}

/** `iptables -F` / `nft flush ruleset` — flush the firewall rules */
function matchFirewall(tokens: string[]): FloorMatch | null {
  if (baseName(tokens[0] ?? '') === 'iptables' && tokens.slice(1).includes('-F')) {
    return { matched: true, pattern: 'iptables -F', why: 'flush the firewall rules' };
  }
  if (baseName(tokens[0] ?? '') === 'nft' && tokens[1] === 'flush' && tokens[2] === 'ruleset') {
    return { matched: true, pattern: 'nft flush ruleset', why: 'flush the firewall rules' };
  }
  return null;
}

/**
 * Run one command against the floor.
 *
 * @param command the final command or the command template
 */
export function matchDangerFloor(command: string): FloorMatch {
  return matchDangerFloorArgv(tokenizeCommand(command));
}

/**
 * Run the floor against an argv.
 *
 * Why there is an argv layer: at runtime it is the encoded final command
 * that is checked — and the tokens of that command have already been split
 * (`actions/encoder` uses the same `tokenizeCommand`). Splitting it again
 * would lose the quoting.
 *
 * → The validator checks the template (`matchDangerFloor`), the runtime
 *   checks the argv (this one).
 *   There is only one matcher (`FLOOR_ENTRIES` plus the three special
 *   cases).
 */
export function matchDangerFloorArgv(tokens: string[]): FloorMatch {
  if (tokens.length === 0) return NO_MATCH;

  for (const entry of FLOOR_ENTRIES) {
    for (const token of tokens) {
      if (matchesPattern(token, entry.pattern)) {
        return { matched: true, pattern: entry.pattern, why: entry.why };
      }
    }
  }

  return matchDd(tokens) ?? matchRmRoot(tokens) ?? matchFirewall(tokens) ?? NO_MATCH;
}

/** The floor table itself (for the command that shows the table) */

export function dangerFloorEntries(): readonly { pattern: string; why: string }[] {
  return FLOOR_ENTRIES;
}

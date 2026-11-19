/**
 * 危险地板（契约 `docs/spec/02-board-pack.md` §5.2 与 §5.2.1）。
 *
 * ── 它是什么 ──
 *
 * 包自己声明 `danger`。但 agent 可以写包——如果没有任何别的约束，
 * 一个把 `reboot` 写成 `reversible` 的包就能跳过人的确认，**分档就成了摆设**。
 *
 * 所以有一条**地板**：
 *
 * > **某些操作永远是 `destructive`，不管包怎么声明。**
 *
 * ── 匹配规范（§5.2.1）──
 *
 * 1. 匹配单位是 argv 的**单个词元**（不是子串）；
 * 2. 词元相等才命中——`upgrade_status.sh` **不**命中 `upgrade`；
 * 3. 仅当模式以 `*` 结尾才允许前缀匹配（`flash*` 命中 `flash_uboot`）；
 * 4. 路径类模式先做路径规范化；
 * 5. `dd` 类要匹配 `dd` 词元 + **目标参数**命中块设备路径；
 * 6. `rm -rf /` 类要匹配 `rm` + `-rf`/`-fr` + 规范化后等于 `/`；
 * 7. **匹配不上不等于安全**——表外命令按包的声明走，但**记一条 warning**。
 */

/** 当前的地板表版本。包里的 `danger_floor_version` 必须是它 */
export const DANGER_FLOOR_VERSION = 1;

/** v1 的地板表（§5.2 的六条） */
interface FloorEntry {
  /** 模式。带 `*` 的是前缀匹配 */
  pattern: string;
  /** 这一条拦的是什么（给人看） */
  why: string;
}

const FLOOR_ENTRIES: readonly FloorEntry[] = [
  { pattern: 'reboot', why: 'reboot' },
  { pattern: 'shutdown', why: 'shut down' },
  { pattern: 'poweroff', why: 'shut down' },
  { pattern: 'halt', why: 'halt' },
  { pattern: 'flash*', why: 'flash storage' },
  // `erase` / `burn` 是**精确匹配**：契约没有给它们前缀例句，
  // 而 `erase_cache` / `burn_count` 是**无害**的常见名——
  // 前缀匹配在这里制造的是**假阳性**，不是堵洞。
  { pattern: 'erase', why: 'erase storage' },
  { pattern: 'burn', why: 'burn storage' },
  { pattern: 'upgrade', why: 'upgrade' },
  // `mkfs*` 而不是 `mkfs`：`mkfs.ext4` 与 `mkfs` 是**同一个操作**。
  // 契约 §5.2 的表写的是 `mkfs`，但 §5.2.1 的前缀规则（`flash*` 命中
  // `flash_uboot`）说明带后缀的同义命令也算——**地板是下限，不许有洞**。
  // 这条差异记在 `docs/06` C10，由用户拍板。
  { pattern: 'mkfs*', why: 'format' },
];

/** 裸写块设备的目标路径（前缀匹配） */
const BLOCK_DEVICE_PATTERNS = ['/dev/mmcblk*', '/dev/sd*', '/dev/nvme*'];

/** 一次匹配的结果 */
export interface FloorMatch {
  matched: boolean;
  /** 命中的地板条目（给人看）。没命中是 null */
  pattern: string | null;
  /** 为什么要拦它（给人看） */
  why: string | null;
}

const NO_MATCH: FloorMatch = { matched: false, pattern: null, why: null };

/**
 * 按 shell 词法把命令切成 argv 序列。
 *
 * **不执行 shell、不做变量展开、不做 glob 展开**（§5.2.1 的顺序：
 * 先编码参数 → 再切 argv → 再匹配地板）。
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
 * 路径规范化：展开 `..`、合并重复 `/`、去掉尾部 `/`。
 *
 * 地板按**路径**比较（`/dev/mmcblk0` 与 `/dev/mmcblk0/` 是同一个东西）。
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
 * 词元的**basename**（`/sbin/reboot` → `reboot`）。
 *
 * 契约 §5.2.1 写的是「词元相等」——但真实的调用几乎都带绝对路径
 * （`/sbin/reboot`、`/usr/sbin/shutdown`），
 * **只按字面实现，地板在真实写法上是空的**。
 * 这条差异记在 `docs/06` C13，由用户拍板。
 */
function baseName(token: string): string {
  const parts = token.split('/');
  return parts[parts.length - 1] ?? token;
}

/** 词元与模式的匹配：相等，或模式带 `*` 的前缀匹配 */
function matchesPattern(token: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    return token.startsWith(pattern.slice(0, -1));
  }
  if (token === pattern) return true;
  // **basename 也算**（`/sbin/reboot` → `reboot`）
  return baseName(token) === pattern;
}

function isBlockDevice(path: string): boolean {
  const p = normalizePath(path);
  return BLOCK_DEVICE_PATTERNS.some((pat) => matchesPattern(p, pat));
}

/**
 * `dd` 写到块设备。
 *
 * 目标参数是 `of=` 的值，或**紧随其后**的非选项参数（§5.2.1）。
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
 * `rm -rf /` 及其等价形式。
 *
 * 标志字母散着写也算（`-rf` / `-fr` / `-r -f`）——
 * 它们表达的是同一件事。
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
    // `/*` 展开后就是根目录下的全部条目——**等价于 `/`**
    if (p === '/' || p === '/*') {
      return { matched: true, pattern: 'rm -rf /', why: 'delete the root' };
    }
  }
  return null;
}

/** `iptables -F` / `nft flush ruleset` —— 清空防火墙规则 */
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
 * 拿一条命令去撞地板。
 *
 * @param command 最终命令或命令模板
 */
export function matchDangerFloor(command: string): FloorMatch {
  return matchDangerFloorArgv(tokenizeCommand(command));
}

/**
 * 拿 **argv** 撞地板。
 *
 * **为什么要有 argv 这一层**：运行时要查的是**编码后的最终命令**——
 * 而那一条命令的词已经被切好了（`actions/encoder` 用的就是同一个
 * `tokenizeCommand`）。再切一遍会丢掉引号信息。
 *
 * → 校验器查模板（`matchDangerFloor`），运行时查 argv（这个）。
 * **匹配器只有一份**（`FLOOR_ENTRIES` + 三条特判）。
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

/** 地板表本身（给「看看这张表」的命令用） */
export function dangerFloorEntries(): readonly { pattern: string; why: string }[] {
  return FLOOR_ENTRIES;
}

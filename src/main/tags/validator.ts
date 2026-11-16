import type { BoardPack, ReaderDef } from './schema';
import { getKind } from './kinds';
import {
  isBoardCapability,
  isCoreTag,
  isCustomTag,
  isImplementedCapability,
  matchTagPattern,
} from './vocabulary';
import { DANGER_FLOOR_VERSION, matchDangerFloor, tokenizeCommand } from './floor';
import { collectPlaceholders } from '../util/shell-quote';

/**
 * **shell 元字符**（**会让一段文本变成两条命令** ✓）。
 *
 * → **reader 的参数值会被拼进 shell** ✓ → **值里有这些就是第二条命令** ✓。
 * → **注意不含正则的元字符** ✓（`^` `(` `)` `[` `]` `.` `+` `*` ✓）——
 *   **正则不是 shell** ✓（`exec_regex` 的 `pattern` 是给输出用的 ✓ → 豁免 ✓）。
 */
const SHELL_METACHARACTERS: readonly string[] = [';', '|', '&', '`', '$', '>', '<', '\n', '\r'];

/**
 * **不进 shell 的参数**（**按 kind + 参数名** ✓ —— **封闭清单** ✓）。
 *
 * → `exec_regex.command` 是**一条命令** ✓（**规则 30 管它** ✓）；
 * → `exec_regex.pattern` 是**正则** ✓（**只作用于输出** ✓）；
 * → `script.*` 是**宿主路径** ✓（**而且 script 被规则 31 禁了** ✓）。
 */
const NOT_IN_SHELL: Record<string, readonly string[]> = {
  exec_regex: ['command', 'pattern'],
  script: ['path', 'interpreter'],
};

/**
 * **解释器 / 下载器 / 提权器**（**包装起来就绕过了危险地板** ✓）。
 *
 * → 地板表匹配的是**词** ✓ —— `bash -c 'rm -rf /'` **一个词都不匹配** ✓
 * → **所以这些词不许出现在 reader 的命令里** ✓（**任何位置** ✓）。
 */
const SHELL_WRAPPERS: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'ash',
  'env', 'xargs', 'eval', 'exec', 'source',
  'python', 'python2', 'python3', 'perl', 'ruby', 'php', 'node', 'deno', 'bun',
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ftp',
  'ssh', 'scp', 'rsync', 'busybox',
  'sudo', 'su', 'doas', 'nsenter', 'unshare', 'chroot',
]);

/**
 * 板型包的校验器——契约 `docs/spec/02-board-pack.md` §七 的 **31 条规则**。
 *
 * **「这 27 条就是契约本身」**（契约原话）：实现层必须逐条实现，
 * 缺一条都不算实现了板型包格式。
 *
 * ── 两条设计约定 ──
 *
 * **1. 每条规则只报「它自己该报的」。**
 * 同一个坏包可能违反好几条规则——**每条都要报**（用户要一次看到全部问题，
 * 而不是修一个跑一次）。但**同一件事**只由一条规则报：
 * 规则 3（占空比不许叫 usage）与规则 4（没声明 measure）是两件事；
 * 规则 15（destructive 的回读形式不对）与规则 27（动作压根没写回读）也是两件事。
 *
 * **2. 报告里带规则号。**
 * 「包不合法」没有用；「**规则 16** 破了：这条命令命中危险地板
 * （reboot），但动作声明成 reversible」才有用。
 */

/** 一条校验结果 */
export interface ValidationIssue {
  severity: 'error' | 'warning';
  /** 契约里的规则号（1..27）。**报告里必须带它** */
  rule: number;
  /** 包内的位置，如 `readers[2].provides[0].tag` */
  path: string;
  /** 给人看的一句话 */
  message: string;
}

/** `readback.kind` 的封闭枚举（规则 23） */
const READBACK_KINDS = new Set(['file_equals', 'command_ok', 'verify', 'none']);

/** 动作参数的封闭类型（规则 20） */
const PARAM_TYPES = new Set(['integer', 'number', 'string', 'boolean', 'enum']);

/** 取出文本里所有的 `{param}` 占位名（去重）。**占位正则只有一份**（`util/shell-quote.ts`） */
function placeholders(text: string | undefined): string[] {
  if (typeof text !== 'string') return [];
  return collectPlaceholders(text);
}

/** tag 是不是 `*.usage` 这一类 */
function isUsageTag(tag: string): boolean {
  return tag.endsWith('.usage');
}

/** 两个 tag 模式会不会撞车（规则 2） */
function patternsOverlap(a: string, b: string): boolean {
  const as = a.split('.');
  const bs = b.split('.');
  if (as.length !== bs.length) return false;
  for (let i = 0; i < as.length; i += 1) {
    if (as[i] === '*' || bs[i] === '*') continue;
    if (as[i] !== bs[i]) return false;
  }
  return true;
}

/** 包里所有 reader（readers + custom），带路径前缀 */
function allReaders(pack: BoardPack): { reader: ReaderDef; path: string }[] {
  return [
    ...pack.readers.map((reader, i) => ({ reader, path: `readers[${i}]` })),
    ...pack.custom.map((reader, i) => ({ reader, path: `custom[${i}]` })),
  ];
}

/**
 * 校验一个板型包。
 *
 * @returns 全部问题。**空数组 = 这个包合法。**
 */
export function validatePack(pack: BoardPack): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const err = (rule: number, path: string, message: string): void => {
    out.push({ severity: 'error', rule, path, message });
  };
  const warn = (rule: number, path: string, message: string): void => {
    out.push({ severity: 'warning', rule, path, message });
  };

  const readers = allReaders(pack);

  // ── 规则 1 · tag 必须落在核心词表或 custom.<本包 id>. 下 ──
  for (const { reader, path } of readers) {
    reader.provides.forEach((p, i) => {
      if (!isCoreTag(p.tag) && !isCustomTag(p.tag, pack.id)) {
        err(
          1,
          `${path}.provides[${i}].tag`,
          `tag「${p.tag}」不在核心词表里，也不是本包的 custom 命名空间（custom.${pack.id}.*）`,
        );
      }
    });
  }

  // ── 规则 2 · 两个 reader 的 tag 模式不得重叠 ──
  const tagEntries: { tag: string; path: string }[] = [];
  for (const { reader, path } of readers) {
    reader.provides.forEach((p, i) => {
      tagEntries.push({ tag: p.tag, path: `${path}.provides[${i}].tag` });
    });
  }
  for (let i = 0; i < tagEntries.length; i += 1) {
    for (let j = i + 1; j < tagEntries.length; j += 1) {
      const a = tagEntries[i]!;
      const b = tagEntries[j]!;
      if (patternsOverlap(a.tag, b.tag)) {
        err(2, b.path, `tag「${b.tag}」与 ${a.path} 的「${a.tag}」会撞车（运行时两个 reader 会写到同一个 tag 上）`);
      }
    }
  }

  // ── 规则 7 · tag 与 sample 的 * 数量必须一致 ──
  for (const { reader, path } of readers) {
    reader.provides.forEach((p, i) => {
      const tagStars = (p.tag.match(/\*/g) ?? []).length;
      const sampleStars = (p.sample.match(/\*/g) ?? []).length;
      if (tagStars !== sampleStars) {
        err(
          7,
          `${path}.provides[${i}]`,
          `tag「${p.tag}」有 ${tagStars} 个通配段，sample「${p.sample}」有 ${sampleStars} 个——必须一样多`,
        );
      }
    });
  }

  // ── 规则 3 · devfreq_load 的 duty_cycle 不得绑到任何 *.usage ──
  // ── 规则 4 · 绑到 *.usage 却没有声明 measure ──
  for (const { reader, path } of readers) {
    if (reader.kind !== 'devfreq_load') continue;
    const measure = reader.args?.['measure'];
    for (const [i, p] of reader.provides.entries()) {
      if (!isUsageTag(p.tag)) continue;
      if (measure === 'duty_cycle' && p.sample === 'duty') {
        err(
          3,
          `${path}.provides[${i}].tag`,
          `devfreq_load 的 duty 是**时钟占空比**（空闲时读 100），不能绑到「${p.tag}」上`,
        );
      }
      if (measure !== 'utilization') {
        // 契约规则 4 的判据是「**必须声明 measure: utilization**」——
        // **等于** utilization，不是「非空」。
        //
        // 「非空」会让 `measure: utilzation`（拼错）一路放行——
        // 而 devfreq 的 load 文件读出的是**占空比**（空闲时 100），
        // 于是占空符被原样发布成利用率。**那是这个工程最在意的那类假数。**
        err(
          4,
          `${path}.provides[${i}].tag`,
          measure === undefined
            ? `绑到「${p.tag}」却没有声明 measure——「没说是利用率」不能当成「是利用率」`
            : `绑到「${p.tag}」但 measure 是「${String(measure)}」——必须是 utilization`,
        );
      }
    }
  }

  // ── 规则 5 · proc_stat 必须把 usage 绑到 cpu.usage ──
  for (const { reader, path } of readers) {
    if (reader.kind !== 'proc_stat') continue;
    const ok = reader.provides.some((p) => p.tag === 'cpu.usage' && p.sample === 'usage');
    if (!ok) {
      err(5, `${path}.provides`, 'proc_stat 必须把 usage 绑到 cpu.usage（首读 pending 的语义靠这一条）');
    }
  }

  // ── 规则 6 · provides[].sample 必须是该 kind 能产出的 sample ──
  // ── 规则 8 · reader 声明的参数必须在 kind 的 schema 里存在 ──
  // ── 规则 9 · 必填参数不能缺 ──
  for (const { reader, path } of readers) {
    const kind = getKind(reader.kind);
    if (kind === undefined) {
      err(6, `${path}.kind`, `kind「${reader.kind}」不在 v1 的清单里（契约 §2.4）`);
      continue;
    }

    for (const [i, p] of reader.provides.entries()) {
      if (kind.unboundedSamples === true) continue;
      const ok = kind.samples.some((s) => matchTagPattern(s, p.sample));
      if (!ok) {
        err(
          6,
          `${path}.provides[${i}].sample`,
          `sample「${p.sample}」不是 kind「${kind.id}」能产出的（它能产出：${kind.samples.join(' / ')}）`,
        );
      }
    }

    const args = reader.args ?? {};
    for (const key of Object.keys(args)) {
      if (!(key in kind.params)) {
        err(8, `${path}.args.${key}`, `kind「${kind.id}」没有这个参数（它有：${Object.keys(kind.params).join(' / ')}）`);
        continue;
      }
      // **取值**也要合 schema：`measure: utilzation` 这种拼错，
      // 参数名是对的、值不在 enum 清单里——**一路放行就是假数**。
      const spec = kind.params[key]!;
      if (spec.values !== undefined) {
        const value = args[key];
        if (typeof value === 'string' && !spec.values.includes(value)) {
          err(
            8,
            `${path}.args.${key}`,
            `kind「${kind.id}」的「${key}」只接受这些值：${spec.values.join(' / ')}（实际是「${value}」）`,
          );
        }
      }
    }

    for (const [name, spec] of Object.entries(kind.params)) {
      if (spec.required === true && args[name] === undefined) {
        err(9, `${path}.args.${name}`, `kind「${kind.id}」的「${name}」是必填参数`);
      }
      if (spec.oneOf !== undefined) {
        const given = spec.oneOf.some((k) => args[k] !== undefined);
        if (!given) {
          err(9, `${path}.args`, `「${spec.oneOf.join('」或「')}」至少要给一个`);
        }
      }
    }
  }

  // ── 规则 11 · match.models 非空字符串列表；match.mode 只能是 exact/substring ──
  if (pack.match !== undefined) {
    if (pack.match.models.length === 0) {
      err(11, 'match.models', 'models 不能是空列表（自动识别靠它）');
    }
    for (const [i, m] of pack.match.models.entries()) {
      if (m.length === 0) err(11, `match.models[${i}]`, '型号不能是空串');
    }
    if (pack.match.mode !== 'exact' && pack.match.mode !== 'substring') {
      err(11, 'match.mode', `mode 只能是 exact 或 substring，实际是「${pack.match.mode}」`);
    }
  }

  // ── 规则 12 · action 的 readback.tag 必须是本包提供的 tag ──
  const providedTags = tagEntries.map((t) => t.tag);

  // ── 规则 13 / 14 / 15 / 20 / 21 / 22 / 23 / 27 逐个动作查 ──
  pack.actions.forEach((action, i) => {
    const path = `actions[${i}]`;
    const declared = Object.keys(action.params ?? {});

    // 规则 13 · 占位必须声明
    const used = new Set([
      ...placeholders(action.command),
      ...placeholders(action.readback?.path),
      ...placeholders(typeof action.readback?.expect === 'string' ? action.readback.expect : undefined),
    ]);
    for (const name of used) {
      if (!declared.includes(name)) {
        err(13, `${path}.command`, `占位 {${name}} 对应的参数没有声明`);
      }
    }

    // 规则 14 · 声明了但没用的参数是死参数
    for (const name of declared) {
      if (!used.has(name)) {
        err(14, `${path}.params.${name}`, `参数「${name}」声明了但没在命令或回读里用到`);
      }
    }

    // 规则 20 · 参数的类型封闭
    for (const [name, spec] of Object.entries(action.params ?? {})) {
      const at = `${path}.params.${name}`;
      if (!PARAM_TYPES.has(spec.type)) {
        err(20, at, `type「${spec.type}」不是封闭类型表里的值（${[...PARAM_TYPES].join(' / ')}）`);
        continue;
      }
      if (spec.type === 'enum') {
        if (spec.values === undefined || spec.values.length === 0) {
          err(20, at, 'enum 必须有非空的 values');
        }
      }
      if (spec.type === 'string' && spec.maxLength === undefined) {
        err(20, at, 'string 参数必须声明 maxLength（没有上限的字符串参数就是注入面）');
      }
    }

    // 规则 21 · 占位不得自带引号
    for (const m of action.command.matchAll(/['"]\{([A-Za-z_][A-Za-z0-9_]*)\}['"]/g)) {
      err(21, `${path}.command`, `占位 {${m[1]}} 自带引号——引号由运行时统一编码，叠加会出错`);
    }

    // 规则 22 · guard 必须是 params 声明域的子集
    for (const [name, guard] of Object.entries(action.guard ?? {})) {
      const at = `${path}.guard.${name}`;
      const param = action.params?.[name];
      if (param === undefined) {
        err(22, at, `guard 引用了没有声明的参数「${name}」`);
        continue;
      }
      if (guard.min !== undefined && param.min !== undefined && guard.min < param.min) {
        err(22, at, `guard 的下界 ${guard.min} 小于参数声明域的下界 ${param.min}（guard 只能缩小）`);
      }
      if (guard.max !== undefined && param.max !== undefined && guard.max > param.max) {
        err(22, at, `guard 的上界 ${guard.max} 大于参数声明域的上界 ${param.max}（guard 只能缩小）`);
      }
    }

    // 规则 23 · readback.kind 属于封闭枚举
    const kind = action.readback?.kind;
    if (kind !== undefined && !READBACK_KINDS.has(kind)) {
      err(23, `${path}.readback.kind`, `kind「${kind}」不是回读形式里的值（${[...READBACK_KINDS].join(' / ')}）`);
    }

    // 规则 27 · 每个 action 必须有 readback；none 必须带非空 consequence
    if (action.readback === undefined) {
      err(27, `${path}.readback`, '每个动作都必须声明 readback（没有可回读状态就显式写 kind: none）');
    } else if (kind === 'none') {
      const consequence = action.readback.consequence;
      if (typeof consequence !== 'string' || consequence.trim().length === 0) {
        err(27, `${path}.readback.consequence`, 'kind: none 必须带一个非空的 consequence（用户批准的是「我知道它会做这件事」）');
      } else {
        // **逐动作 warning**（ADR-D25 决策 6、契约 §4.4.1 第四条规矩）：
        // 「想偷懒跳过回读的包作者会立刻看到一串警告——**这个可见性就是主要防线**」。
        warn(
          27,
          `${path}.readback`,
          '这个动作没有可观测状态（kind: none）——用户批准的是「我知道它会做这件事」',
        );
      }
    }

    // 规则 15 · destructive 的回读形式：不得用 command_ok，也不得用 none
    if (action.danger === 'destructive' && action.readback !== undefined) {
      if (kind === 'command_ok' || kind === 'none') {
        err(15, `${path}.readback.kind`, `destructive 的动作不能用 ${kind}（不可逆动作不能盲发）`);
      }
    }

    // 规则 12 · readback.tag 必须是本包提供的 tag
    const readbackTag = action.readback?.tag;
    if (readbackTag !== undefined) {
      const ok = providedTags.some((t) => matchTagPattern(t, readbackTag));
      if (!ok) {
        err(12, `${path}.readback.tag`, `tag「${readbackTag}」不是本包提供的 tag（闭环断了）`);
      }
    }

    // 规则 16 · 命中危险地板的命令必须声明为 destructive
    const floor = matchDangerFloor(action.command);
    if (floor.matched && action.danger !== 'destructive') {
      err(16, `${path}.command`, `命令命中危险地板（${floor.pattern}，${floor.why}），必须声明为 destructive`);
    }
  });

  // ── 规则 17 · 每个 reader 必须属于恰好一个 poll group ──
  for (const { reader, path } of readers) {
    const groups = pack.poll_groups.filter((g) => g.readers.includes(reader.id));
    if (groups.length === 0) {
      err(17, path, `reader「${reader.id}」不属于任何 poll group（没组 = 没有往返 = 永远读不到）`);
    } else if (groups.length > 1) {
      err(17, path, `reader「${reader.id}」属于 ${groups.length} 个 poll group（只能是恰好一个）`);
    }
  }
  for (const [gi, group] of pack.poll_groups.entries()) {
    for (const [ri, rid] of group.readers.entries()) {
      const known = readers.some((r) => r.reader.id === rid);
      if (!known) {
        err(17, `poll_groups[${gi}].readers[${ri}]`, `组里写着 reader「${rid}」，但包里没有这个 reader`);
      }
    }
  }

  // ── 规则 18 · poll group 的 interval_ms 不低于 200 ──
  pack.poll_groups.forEach((group, gi) => {
    if (group.interval_ms < 200) {
      err(18, `poll_groups[${gi}].interval_ms`, `采样间隔 ${group.interval_ms}ms 太密（低于 200ms 会打爆板子）`);
    }
  });

  // ── 规则 19 · exec_regex / script 存在时打印警告 ──
  for (const { reader, path } of readers) {
    if (reader.kind === 'exec_regex' || reader.kind === 'script') {
      warn(19, path, `kind「${reader.kind}」在板子上执行任意代码（它的执行事件进审计日志）`);
    }
  }

  // ── 规则 28 · reader 的取数命令不许命中危险地板 ──
  //
  // → **板型包直接生效**（用户 2026-11-16：「**板子描述文件说了算**」✓ · ADR-D46 ✓）
  //   → **「启用前要人确认」那道门没了** ✓ → **这条规则就是替代它的那道** ✓
  // → **`exec_regex` 的命令原样上板** ✓ → **它必须自己过地板** ✓
  //   （**reader 不是动作** ✓ —— 它不过执行器 ✓ —— **所以这里判** ✓）
  for (const { reader, path } of readers) {
    const kind = getKind(reader.kind);
    if (kind === undefined) continue;
    let fragment: string;
    try {
      fragment = kind.fetch(reader.args ?? {});
    } catch {
      // **参数不对** ✓ → **规则 8 / 9 已经报过了** ✓ → **这里不重复报** ✓
      continue;
    }
    const floor = matchDangerFloor(fragment);
    if (floor.matched) {
      err(
        28,
        path,
        `这个 reader 的取数命令命中了危险地板（${floor.why ?? '危险命令'}）——` +
          '板型包直接生效，所以这里必须拦住',
      );
    }
  }

  // ── 规则 29 · reader 的参数值不许含 shell 元字符 ──
  //
  // → **reader 的取数片段会被拼进一条 shell 命令** ✓（`fetch.ts` ✓）
  //   → **包里的值带元字符 = 拼出第二条命令** ✓（**这是绕过地板的路** ✓）
  // → 例外：**不进 shell 的参数** ✓（`exec_regex` 的 `command`/`pattern` ✓ · `script` 的路径 ✓）
  for (const { reader, path } of readers) {
    const exempt = NOT_IN_SHELL[reader.kind] ?? [];
    const args = reader.args ?? {};
    for (const [key, value] of Object.entries(args)) {
      if (exempt.includes(key)) continue;
      if (typeof value !== 'string') continue;
      const hit = SHELL_METACHARACTERS.find((m) => value.includes(m));
      if (hit !== undefined) {
        err(
          29,
          `${path}.args.${key}`,
          `这个值里有 shell 元字符「${hit}」——reader 的取数片段会被拼进 shell（` +
            '一个元字符就是第二条命令）',
        );
      }
    }
  }

  // ── 规则 30 · `exec_regex` 的命令不许是「解释器包装」 ──
  //
  // → **它的命令原样上板** ✓ → **地板表只有那几条词** ✓
  //   → `bash -c 'rm -rf /'` **匹配不上地板** ✓ → **规则 28 放行** ✓ → **危险** ✓
  // → 所以：**命令里不许出现解释器 / 下载器 / 提权器** ✓（**任何位置** ✓ ——
  //   **包装器就是绕过地板的那条路** ✓）。
  for (const { reader, path } of readers) {
    if (reader.kind !== 'exec_regex') continue;
    const command = reader.args?.['command'];
    if (typeof command !== 'string') continue;
    for (const token of tokenizeCommand(command)) {
      const base = token.split('/').pop() ?? token;
      if (!SHELL_WRAPPERS.has(base)) continue;
      err(
        30,
        `${path}.args.command`,
        `命令里有「${base}」——它是解释器 / 下载器 / 提权器，` +
          '包装起来就绕过了危险地板（地板表匹配的是词，不是语义）',
      );
      break;
    }
  }

  // ── 规则 31 · 板型包里不许用 `script` kind ──
  //
  // → **它执行的是脚本正文** ✓（**正文一个字都没查** ✓ → **地板看不见它** ✓）
  // → 而且运行时**还不给它推脚本** ✓（`sampler.ts` ✓ → 它报 unavailable ✓）
  //   → **那是一个还没开的洞** ✓ → **不许用** ✓（**别留一个「将来会开」的洞** ✓）。
  for (const { reader, path } of readers) {
    if (reader.kind !== 'script') continue;
    err(31, `${path}.kind`, 'kind「script」执行的是脚本正文（地板看不见它）——板型包里不许用');
  }

  // ── 规则 24 · danger_floor_version 必须是已知版本 ──
  if (pack.danger_floor_version !== undefined && pack.danger_floor_version !== DANGER_FLOOR_VERSION) {
    err(
      24,
      'danger_floor_version',
      `地板表版本 ${pack.danger_floor_version} 不认识（当前只有 ${DANGER_FLOOR_VERSION}）`,
    );
  }

  // ── 规则 25 / 26 · requires.capabilities 的封闭词表与已实现能力集 ──
  pack.requires.capabilities.forEach((cap, i) => {
    if (!isBoardCapability(cap)) {
      err(25, `requires.capabilities[${i}]`, `能力「${cap}」不在板级词表里（shell / exec / stream / files）`);
      return;
    }
    if (!isImplementedCapability(cap)) {
      err(
        26,
        `requires.capabilities[${i}]`,
        `能力「${cap}」当前**给不出来**（Stream 契约还没写，声明了就是承诺一个不存在的交付）`,
      );
    }
  });

  return out;
}

/** 只要 error（warning 不影响包的有效性） */
export function errorsOf(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => i.severity === 'error');
}

/** 只要 warning */
export function warningsOf(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => i.severity === 'warning');
}

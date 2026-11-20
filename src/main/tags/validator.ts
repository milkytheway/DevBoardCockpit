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
 * The shell metacharacters (they turn one piece of text into two
 * commands).
 *
 * → The argument values of a reader are spliced into the shell → a
 *   value that carries one of them is a second command.
 * → The metacharacters of a regular expression are not among them
 *   (`^` `(` `)` `[` `]` `.` `+` `*`) — a regular expression is not a
 *   shell (the `pattern` of `exec_regex` applies to the output, so it is
 *   exempt).
 */
const SHELL_METACHARACTERS: readonly string[] = [';', '|', '&', '`', '$', '>', '<', '\n', '\r'];

/**
 * The arguments that do not go into the shell (per kind plus argument
 * name — a closed list).
 *
 * → `exec_regex.command` is a command (rule 30 governs it);
 * → `exec_regex.pattern` is a regular expression (it only applies to
 *   the output);
 * → `script.*` are paths on the host (and rule 31 forbids `script`).
 */
const NOT_IN_SHELL: Record<string, readonly string[]> = {
  exec_regex: ['command', 'pattern'],
  script: ['path', 'interpreter'],
};

/**
 * The interpreters / downloaders / privilege escalators (wrapping a
 * command in one of them bypasses the danger floor).
 *
 * → The floor table matches words — `bash -c 'rm -rf /'` does not
 *   match a single word
 * → So these words may not appear in the command of a reader (in any
 *   position).
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
 * The validator of a board pack — the 31 rules of section 7 of the
 * contract `docs/spec/02-board-pack.md`.
 *
 * "These 27 rules are the contract itself" (the words of the contract):
 * the implementation has to implement them one by one, and it does not count
 * as implementing the board pack format while one of them is missing.
 *
 * ── Two design conventions ──
 *
 * 1. Every rule reports only what it is supposed to report.
 * One broken pack may break several rules — all of them have to be
 * reported (the user wants to see all the problems at once, and not to
 * fix one and run again). But one thing is reported by one rule only:
 * rule 3 (a duty cycle may not be called usage) and rule 4 (measure not
 * declared) are two things; rule 15 (the wrong readback form for a
 * destructive action) and rule 27 (the action has no readback at all) are
 * two things as well.
 *
 * 2. The report carries the rule number.
 * "The pack is invalid" is useless; "rule 16 is broken: this command
 * hits the danger floor (reboot) but the action is declared as reversible"
 * is useful.
 */

/** One result of the validation */
export interface ValidationIssue {
  severity: 'error' | 'warning';
  /** The rule number of the contract (1..27). The report has to carry it */
  rule: number;
  /** The place inside the pack, such as `readers[2].provides[0].tag` */
  path: string;
  /** One sentence for the reader */
  message: string;
}

/** The closed enumeration of `readback.kind` (rule 23) */
const READBACK_KINDS = new Set(['file_equals', 'command_ok', 'verify', 'none']);

/** The closed types of an action parameter (rule 20) */
const PARAM_TYPES = new Set(['integer', 'number', 'string', 'boolean', 'enum']);

/** All the `{param}` placeholder names of a text (deduplicated). The placeholder pattern exists only once (`util/shell-quote.ts`) */
function placeholders(text: string | undefined): string[] {
  if (typeof text !== 'string') return [];
  return collectPlaceholders(text);
}

/** Whether the tag is of the `*.usage` kind */
function isUsageTag(tag: string): boolean {
  return tag.endsWith('.usage');
}

/** Whether two tag patterns collide (rule 2) */
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

/** Every reader of the pack (readers + custom), with the path prefix */
function allReaders(pack: BoardPack): { reader: ReaderDef; path: string }[] {
  return [
    ...pack.readers.map((reader, i) => ({ reader, path: `readers[${i}]` })),
    ...pack.custom.map((reader, i) => ({ reader, path: `custom[${i}]` })),
  ];
}

/**
 * Validate a board pack.
 *
 * @returns every problem. An empty array means the pack is valid.
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

  // ── Rule 1 · the tag has to fall in the core vocabulary or under custom.<this pack id>. ──
  for (const { reader, path } of readers) {
    reader.provides.forEach((p, i) => {
      if (!isCoreTag(p.tag) && !isCustomTag(p.tag, pack.id)) {
        err(
          1,
          `${path}.provides[${i}].tag`,
          `tag "${p.tag}" is neither in the core vocabulary nor in this pack's custom namespace (custom.${pack.id}.*)`,
        );
      }
    });
  }

  // ── Rule 2 · the tag patterns of two readers must not overlap ──
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
        err(2, b.path, `tag "${b.tag}" collides with "${a.tag}" at ${a.path} (at runtime two readers would write to the same tag)`);
      }
    }
  }

  // ── Rule 7 · the tag and the sample must have the same number of * ──
  for (const { reader, path } of readers) {
    reader.provides.forEach((p, i) => {
      const tagStars = (p.tag.match(/\*/g) ?? []).length;
      const sampleStars = (p.sample.match(/\*/g) ?? []).length;
      if (tagStars !== sampleStars) {
        err(
          7,
          `${path}.provides[${i}]`,
          `tag "${p.tag}" has ${tagStars} wildcard segment(s), sample "${p.sample}" has ${sampleStars} — they must be the same number`,
        );
      }
    });
  }

  // ── Rule 3 · the duty_cycle of devfreq_load must not be bound to any *.usage ──
  // ── Rule 4 · bound to *.usage without a declared measure ──
  for (const { reader, path } of readers) {
    if (reader.kind !== 'devfreq_load') continue;
    const measure = reader.args?.['measure'];
    for (const [i, p] of reader.provides.entries()) {
      if (!isUsageTag(p.tag)) continue;
      if (measure === 'duty_cycle' && p.sample === 'duty') {
        err(
          3,
          `${path}.provides[${i}].tag`,
          `the duty of devfreq_load is the **clock duty cycle** (it reads 100 when idle), so it must not be bound to "${p.tag}"`,
        );
      }
      if (measure !== 'utilization') {
        // The criterion of contract rule 4 is "measure: utilization has to be
        // declared" — equal to utilization, not "not empty".
        //
        // "Not empty" would let `measure: utilzation` (a typo) pass all the
        // way — and the load file of devfreq reads a duty cycle (100
        // when idle), so the duty cycle would be published as a utilisation.
        // That is the kind of false number this project cares most
        // about.
        err(
          4,
          `${path}.provides[${i}].tag`,
          measure === undefined
            ? `bound to "${p.tag}" but measure is not declared — "not declared as utilisation" is not the same as "declared as utilisation"`
            : `bound to "${p.tag}" but measure is "${String(measure)}" — it must be utilization`,
        );
      }
    }
  }

  // ── Rule 5 · proc_stat has to bind usage to cpu.usage ──
  for (const { reader, path } of readers) {
    if (reader.kind !== 'proc_stat') continue;
    const ok = reader.provides.some((p) => p.tag === 'cpu.usage' && p.sample === 'usage');
    if (!ok) {
      err(5, `${path}.provides`, 'proc_stat must bind usage to cpu.usage (the pending semantics of the first read depend on this rule)');
    }
  }

  // ── Rule 6 · provides[].sample must be a sample that the kind can produce ──
  // ── Rule 8 · the arguments a reader declares have to exist in the schema of the kind ──
  // ── Rule 9 · a required argument must not be missing ──
  for (const { reader, path } of readers) {
    const kind = getKind(reader.kind);
    if (kind === undefined) {
      err(6, `${path}.kind`, `kind "${reader.kind}" is not in the v1 list (contract §2.4)`);
      continue;
    }

    for (const [i, p] of reader.provides.entries()) {
      if (kind.unboundedSamples === true) continue;
      const ok = kind.samples.some((s) => matchTagPattern(s, p.sample));
      if (!ok) {
        err(
          6,
          `${path}.provides[${i}].sample`,
          `sample "${p.sample}" cannot be produced by kind "${kind.id}" (it can produce: ${kind.samples.join(' / ')})`,
        );
      }
    }

    const args = reader.args ?? {};
    for (const key of Object.keys(args)) {
      if (!(key in kind.params)) {
        err(8, `${path}.args.${key}`, `kind "${kind.id}" has no such parameter (it has: ${Object.keys(kind.params).join(' / ')})`);
        continue;
      }
      // The value has to match the schema too: a typo such as
      // `measure: utilzation` has a correct argument name and a value that
      // is not in the enum list — letting it pass all the way is a false
      // number.
      const spec = kind.params[key]!;
      if (spec.values !== undefined) {
        const value = args[key];
        if (typeof value === 'string' && !spec.values.includes(value)) {
          err(
            8,
            `${path}.args.${key}`,
            `"${key}" of kind "${kind.id}" only accepts these values: ${spec.values.join(' / ')} (it is "${value}")`,
          );
        }
      }
    }

    for (const [name, spec] of Object.entries(kind.params)) {
      if (spec.required === true && args[name] === undefined) {
        err(9, `${path}.args.${name}`, `"${name}" is a required parameter of kind "${kind.id}"`);
      }
      if (spec.oneOf !== undefined) {
        const given = spec.oneOf.some((k) => args[k] !== undefined);
        if (!given) {
          err(9, `${path}.args`, `at least one of ${spec.oneOf.join(' / ')} must be given`);
        }
      }
    }
  }

  // ── Rule 11 · match.models is a non-empty list of strings; match.mode can only be exact/substring ──
  if (pack.match !== undefined) {
    if (pack.match.models.length === 0) {
      err(11, 'match.models', 'models must not be an empty list (automatic detection relies on it)');
    }
    for (const [i, m] of pack.match.models.entries()) {
      if (m.length === 0) err(11, `match.models[${i}]`, 'a model must not be an empty string');
    }
    if (pack.match.mode !== 'exact' && pack.match.mode !== 'substring') {
      err(11, 'match.mode', `mode must be exact or substring, it is "${pack.match.mode}"`);
    }
  }

  // ── Rule 12 · the readback.tag of an action must be a tag this pack provides ──
  const providedTags = tagEntries.map((t) => t.tag);

  // ── Rules 13 / 14 / 15 / 20 / 21 / 22 / 23 / 27 are checked per action ──
  pack.actions.forEach((action, i) => {
    const path = `actions[${i}]`;
    const declared = Object.keys(action.params ?? {});

    // Rule 13 · a placeholder has to be declared
    const used = new Set([
      ...placeholders(action.command),
      ...placeholders(action.readback?.path),
      ...placeholders(typeof action.readback?.expect === 'string' ? action.readback.expect : undefined),
    ]);
    for (const name of used) {
      if (!declared.includes(name)) {
        err(13, `${path}.command`, `the parameter for placeholder {${name}} is not declared`);
      }
    }

    // Rule 14 · a declared but unused parameter is a dead parameter
    for (const name of declared) {
      if (!used.has(name)) {
        err(14, `${path}.params.${name}`, `parameter "${name}" is declared but never used in the command or the readback`);
      }
    }

    // Rule 20 · the type of a parameter is closed
    for (const [name, spec] of Object.entries(action.params ?? {})) {
      const at = `${path}.params.${name}`;
      if (!PARAM_TYPES.has(spec.type)) {
        err(20, at, `type "${spec.type}" is not a value of the closed type table (${[...PARAM_TYPES].join(' / ')})`);
        continue;
      }
      if (spec.type === 'enum') {
        if (spec.values === undefined || spec.values.length === 0) {
          err(20, at, 'enum must have non-empty values');
        }
      }
      if (spec.type === 'string' && spec.maxLength === undefined) {
        err(20, at, 'a string parameter must declare maxLength (a string parameter without an upper bound is an injection surface)');
      }
    }

    // Rule 21 · a placeholder must not carry its own quotes
    for (const m of action.command.matchAll(/['"]\{([A-Za-z_][A-Za-z0-9_]*)\}['"]/g)) {
      err(21, `${path}.command`, `placeholder {${m[1]}} carries its own quotes — the runtime encodes quotes uniformly, so stacking them breaks`);
    }

    // Rule 22 · a guard must be a subset of the declared domain of the params
    for (const [name, guard] of Object.entries(action.guard ?? {})) {
      const at = `${path}.guard.${name}`;
      const param = action.params?.[name];
      if (param === undefined) {
        err(22, at, `guard references a parameter that is not declared: "${name}"`);
        continue;
      }
      if (guard.min !== undefined && param.min !== undefined && guard.min < param.min) {
        err(22, at, `the lower bound ${guard.min} of guard is below the lower bound ${param.min} of the parameter declaration (a guard can only narrow)`);
      }
      if (guard.max !== undefined && param.max !== undefined && guard.max > param.max) {
        err(22, at, `the upper bound ${guard.max} of guard is above the upper bound ${param.max} of the parameter declaration (a guard can only narrow)`);
      }
    }

    // Rule 23 · readback.kind belongs to the closed enumeration
    const kind = action.readback?.kind;
    if (kind !== undefined && !READBACK_KINDS.has(kind)) {
      err(23, `${path}.readback.kind`, `kind "${kind}" is not a value of the readback forms (${[...READBACK_KINDS].join(' / ')})`);
    }

    // Rule 27 · every action must have a readback; none must carry a non-empty consequence
    if (action.readback === undefined) {
      err(27, `${path}.readback`, 'every action must declare a readback (if there is no readable state, write kind: none explicitly)');
    } else if (kind === 'none') {
      const consequence = action.readback.consequence;
      if (typeof consequence !== 'string' || consequence.trim().length === 0) {
        err(27, `${path}.readback.consequence`, 'kind: none must carry a non-empty consequence (what the user approves is "I know it will do this")');
      } else {
        // A warning per action (decision 6 of ADR-D25, the fourth rule of
        // contract section 4.4.1): "a pack author who wants to skip the
        // readback sees a row of warnings at once — that visibility is
        // the main line of defence".
        warn(
          27,
          `${path}.readback`,
          'this action has no observable state (kind: none) — what the user approves is "I know it will do this"',
        );
      }
    }

    // Rule 15 · the readback form of a destructive action: neither command_ok nor none
    if (action.danger === 'destructive' && action.readback !== undefined) {
      if (kind === 'command_ok' || kind === 'none') {
        err(15, `${path}.readback.kind`, `a destructive action must not use ${kind} (an irreversible action must not be fired blindly)`);
      }
    }

    // Rule 12 · the readback.tag must be a tag this pack provides
    const readbackTag = action.readback?.tag;
    if (readbackTag !== undefined) {
      const ok = providedTags.some((t) => matchTagPattern(t, readbackTag));
      if (!ok) {
        err(12, `${path}.readback.tag`, `tag "${readbackTag}" is not a tag this pack provides (the closed loop is broken)`);
      }
    }

    // Rule 16 · a command that hits the danger floor must be declared as destructive
    const floor = matchDangerFloor(action.command);
    if (floor.matched && action.danger !== 'destructive') {
      err(16, `${path}.command`, `the command hits the danger floor (${floor.pattern}, ${floor.why}), so it must be declared as destructive`);
    }
  });

  // ── Rule 17 · every reader must belong to exactly one poll group ──
  for (const { reader, path } of readers) {
    const groups = pack.poll_groups.filter((g) => g.readers.includes(reader.id));
    if (groups.length === 0) {
      err(17, path, `reader "${reader.id}" belongs to no poll group (no group means no round trip means it is never read)`);
    } else if (groups.length > 1) {
      err(17, path, `reader "${reader.id}" belongs to ${groups.length} poll groups (it must belong to exactly one)`);
    }
  }
  for (const [gi, group] of pack.poll_groups.entries()) {
    for (const [ri, rid] of group.readers.entries()) {
      const known = readers.some((r) => r.reader.id === rid);
      if (!known) {
        err(17, `poll_groups[${gi}].readers[${ri}]`, `the group lists reader "${rid}", but the pack has no such reader`);
      }
    }
  }

  // ── Rule 18 · the interval_ms of a poll group is not below 200 ──
  pack.poll_groups.forEach((group, gi) => {
    if (group.interval_ms < 200) {
      err(18, `poll_groups[${gi}].interval_ms`, `the sampling interval ${group.interval_ms}ms is too tight (below 200ms it overwhelms the board)`);
    }
  });

  // ── Rule 19 · a warning is printed when exec_regex / script are present ──
  for (const { reader, path } of readers) {
    if (reader.kind === 'exec_regex' || reader.kind === 'script') {
      warn(19, path, `kind "${reader.kind}" runs arbitrary code on the board (its execution events go into the audit log)`);
    }
  }

  // ── Rule 28 · the fetch command of a reader must not hit the danger floor ──
  //
  // → A board pack takes effect directly (the user on 2026-11-16: "the
  //   board description file decides" ✓ · ADR-D46 ✓)
  //   → The gate of "a human confirms before it is enabled" is gone ✓ →
  //   this rule is the one that replaced it ✓
  // → The command of `exec_regex` goes onto the board verbatim ✓ → it
  //   has to pass the floor itself ✓
  //   (a reader is not an action ✓ — it does not go through the
  //   executor ✓ — so it is judged here ✓)
  for (const { reader, path } of readers) {
    const kind = getKind(reader.kind);
    if (kind === undefined) continue;
    let fragment: string;
    try {
      fragment = kind.fetch(reader.args ?? {});
    } catch {
      // The arguments are wrong ✓ → rules 8 / 9 have already reported
      // it ✓ → it is not reported again here ✓
      continue;
    }
    const floor = matchDangerFloor(fragment);
    if (floor.matched) {
      err(
        28,
        path,
        `the fetch command of this reader hits the danger floor (${floor.why ?? 'dangerous command'}) — ` +
          'a board pack takes effect directly, so this has to be blocked here',
      );
    }
  }

  // ── Rule 29 · the argument values of a reader must not carry shell metacharacters ──
  //
  // → The fetch fragment of a reader is spliced into a shell command ✓
  //   (`fetch.ts` ✓)
  //   → A value in the pack that carries a metacharacter splices out a
  //   second command ✓ (that is the way around the floor ✓)
  // → The exception: the arguments that do not go into the shell ✓ (the
  //   `command`/`pattern` of `exec_regex` ✓ · the paths of `script` ✓)
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
          `this value contains the shell metacharacter "${hit}" — the fetch fragment of the reader is spliced into a shell command (` +
            'one metacharacter is a second command)',
        );
      }
    }
  }

  // ── Rule 30 · the command of `exec_regex` must not be an "interpreter wrapper" ──
  //
  // → Its command goes onto the board verbatim ✓ → the floor table has
  //   only those few words ✓
  //   → `bash -c 'rm -rf /'` does not match the floor ✓ → rule 28 lets
  //   it through ✓ → dangerous ✓
  // → So: the command must not contain an interpreter / downloader /
  //   privilege escalator ✓ (in any position — a wrapper is the way
  //   around the floor ✓).
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
        `the command contains "${base}" — it is an interpreter / downloader / privilege escalator, ` +
          'and wrapping it bypasses the danger floor (the floor table matches words, not semantics)',
      );
      break;
    }
  }

  // ── Rule 31 · the kind `script` must not be used in a board pack ──
  //
  // → What it executes is the body of the script ✓ (not one character
  //   of the body is checked ✓ → the floor cannot see it ✓)
  // → And the runtime does not even push the script for it ✓
  //   (`sampler.ts` ✓ → it reports unavailable ✓)
  //   → That is a hole that is not open yet ✓ → it must not be
  //   used ✓ (do not leave a hole that "will be opened later" ✓).
  for (const { reader, path } of readers) {
    if (reader.kind !== 'script') continue;
    err(31, `${path}.kind`, 'kind "script" runs the script body (the floor cannot see it) — it is not allowed in a board pack');
  }

  // ── Rule 24 · danger_floor_version has to be a known version ──
  if (pack.danger_floor_version !== undefined && pack.danger_floor_version !== DANGER_FLOOR_VERSION) {
    err(
      24,
      'danger_floor_version',
      `danger floor version ${pack.danger_floor_version} is unknown (the current one is ${DANGER_FLOOR_VERSION})`,
    );
  }

  // ── Rules 25 / 26 · the closed vocabulary of requires.capabilities and the set of implemented capabilities ──
  pack.requires.capabilities.forEach((cap, i) => {
    if (!isBoardCapability(cap)) {
      err(25, `requires.capabilities[${i}]`, `capability "${cap}" is not in the board-level vocabulary (shell / exec / stream / files)`);
      return;
    }
    if (!isImplementedCapability(cap)) {
      err(
        26,
        `requires.capabilities[${i}]`,
        `capability "${cap}" cannot be delivered **right now** (the Stream contract is not written yet, declaring it promises a delivery that does not exist)`,
      );
    }
  });

  return out;
}

/** Only the errors (a warning does not affect the validity of the pack) */
export function errorsOf(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => i.severity === 'error');
}

/** Only the warnings */

export function warningsOf(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => i.severity === 'warning');
}

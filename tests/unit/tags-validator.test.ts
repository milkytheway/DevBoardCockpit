import { describe, it, expect } from 'vitest';
import { validatePack, type ValidationIssue } from '../../src/main/tags/validator';
import { parseBoardPack } from '../../src/main/tags/pack';
import type { ActionDef, BoardPack, ReaderDef } from '../../src/main/tags/schema';

/**
 * The 31 validation rules.
 *
 * Method: every synthetic pack violates **exactly one rule**.
 *
 * Failing for the right reason matters more than failing at all: a pack that
 * violates three rules at once only proves that the validator complained, not
 * that rule N is implemented. Each rule therefore asserts exactly one error,
 * and that its rule number is N.
 *
 * The real packs stay faithful; the synthetic packs cover the rules.
 */

/**
 * A **valid** minimal pack. Every rule case is derived from it.
 *
 * Its cpu reader binds two tags (`cpu.usage` and `cpu.core.*.usage`), because
 * rules 2 and 7 need the pattern side.
 */
function basePack(): BoardPack {
  return {
    apiVersion: 'devboard/v1',
    kind: 'BoardPack',
    id: 'tiny',
    name: 'minimal pack',
    version: '1.0.0',
    requires: { transports: ['adb'], capabilities: ['exec'], min_contract: 'devboard/v1' },
    poll_groups: [{ id: 'fast', interval_ms: 1000, readers: ['cpu'] }],
    readers: [
      {
        id: 'cpu',
        kind: 'proc_stat',
        args: { stat_path: '/proc/stat', cpuinfo_path: '/proc/cpuinfo' },
        provides: [
          { tag: 'cpu.usage', sample: 'usage' },
          { tag: 'cpu.core.*.usage', sample: 'core.*.usage' },
        ],
      },
    ],
    custom: [],
    actions: [],
  };
}

/** Adds a reader to a group */
function addReader(pack: BoardPack, reader: ReaderDef, group = 'fast'): BoardPack {
  pack.readers.push(reader);
  pack.poll_groups.find((g) => g.id === group)!.readers.push(reader.id);
  return pack;
}

/** Adds an action */
function addAction(pack: BoardPack, action: ActionDef): BoardPack {
  pack.actions.push(action);
  return pack;
}

/** Errors only */
function errors(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => i.severity === 'error');
}

/** Asserts: exactly one error, whose rule number is n */
function expectOnlyRule(pack: BoardPack, n: number): void {
  const errs = errors(validatePack(pack));
  const ofRule = errs.filter((i) => i.rule === n);
  expect(
    ofRule.length,
    `rule ${n} should report one error, but it reported ${ofRule.length}; all errors: ${JSON.stringify(
      errs.map((e) => `${e.rule}@${e.path}`),
    )}`,
  ).toBe(1);
  expect(
    errs.length,
    `this synthetic pack should violate **only** rule ${n}, but it also reported: ${JSON.stringify(
      errs.filter((e) => e.rule !== n).map((e) => `${e.rule}@${e.path}: ${e.message}`),
    )}`,
  ).toBe(1);
}

/** A readback that follows form 1 (reads one tag). **No `kind`** — the contract §4.4 says so */
function tagReadback(tag: string): ActionDef['readback'] {
  return { tag };
}

describe('baseline pack', () => {
  it('a valid pack reports no error', () => {
    expect(errors(validatePack(basePack()))).toEqual([]);
  });
});

describe('rule 1 · a tag must be in the core vocabulary or under custom.<pack id>.', () => {
  it('a tag outside the vocabulary is reported', () => {
    const pack = addReader(basePack(), {
      id: 'mem',
      kind: 'meminfo',
      args: { path: '/proc/meminfo' },
      provides: [{ tag: 'cpu.temperature', sample: 'usage' }],
    });
    expectOnlyRule(pack, 1);
  });

  it('the custom namespace of another pack does not count', () => {
    const pack = addReader(basePack(), {
      id: 'mem',
      kind: 'meminfo',
      args: { path: '/proc/meminfo' },
      provides: [{ tag: 'custom.other.thing', sample: 'usage' }],
    });
    expectOnlyRule(pack, 1);
  });

  it('the custom namespace of this pack is valid', () => {
    const pack = addReader(basePack(), {
      id: 'mem',
      kind: 'meminfo',
      args: { path: '/proc/meminfo' },
      provides: [{ tag: 'custom.tiny.thing', sample: 'usage' }],
    });
    expect(errors(validatePack(pack))).toEqual([]);
  });
});

describe('rule 2 · the tag patterns of two readers must not overlap', () => {
  it('two readers offering the same tag is reported', () => {
    const pack = addReader(basePack(), {
      id: 'cpu2',
      kind: 'proc_stat',
      args: { stat_path: '/proc/stat', cpuinfo_path: '/proc/cpuinfo' },
      provides: [{ tag: 'cpu.usage', sample: 'usage' }],
    });
    expectOnlyRule(pack, 2);
  });

  it('overlapping patterns are reported as well (cpu.core.*.usage against cpu.core.3.usage)', () => {
    const pack = addReader(basePack(), {
      id: 'mem',
      kind: 'meminfo',
      args: { path: '/proc/meminfo' },
      provides: [{ tag: 'cpu.core.3.usage', sample: 'usage' }],
    });
    expectOnlyRule(pack, 2);
  });
});

describe('rule 3 · the duty_cycle of devfreq_load must not be bound to any *.usage', () => {
  it('binding duty_cycle to gpu.usage is reported', () => {
    const pack = addReader(basePack(), {
      id: 'gpu',
      kind: 'devfreq_load',
      args: { path: '/sys/class/devfreq/fb000000.gpu/load', measure: 'duty_cycle' },
      provides: [{ tag: 'gpu.usage', sample: 'duty' }],
    });
    // **Rules 3 and 4 are reported together**: both are true —
    // 3 says a duty is a duty cycle and may not be called a usage, 4 says a usage must declare utilization.
    const errs = errors(validatePack(pack));
    expect(errs.filter((e) => e.rule === 3)).toHaveLength(1);
    expect(errs.filter((e) => e.rule === 4)).toHaveLength(1);
  });
});

describe('rule 4 · a binding to *.usage must declare measure: utilization', () => {
  it('a **misspelled measure** is reported as well (utilzation is not utilization)', () => {
    // The criterion of rule 4 in the contract is "**equal to utilization**", not "not empty".
    // Letting a misspelled measure through means a **duty cycle is published as a utilisation figure** —
    // that is the class of bug this project cares about most (a false number is worse than a zero).
    const pack = addReader(basePack(), {
      id: 'gpu',
      kind: 'devfreq_load',
      args: { path: '/sys/class/devfreq/fb000000.gpu/load', measure: 'utilzation' },
      provides: [{ tag: 'gpu.usage', sample: 'duty' }],
    });
    // Rule 4 (the value is not utilization) and rule 8 (the value is not in the enum list) are **both reported** —
    // both are true, and each points at a different fix.
    const errs = errors(validatePack(pack));
    expect(errs.filter((e) => e.rule === 4)).toHaveLength(1);
    expect(errs.filter((e) => e.rule === 8)).toHaveLength(1);
  });

  it('measure is duty_cycle but the binding is not a duty → rule 4 is reported as well', () => {
    const pack = addReader(basePack(), {
      id: 'gpu',
      kind: 'devfreq_load',
      args: { path: '/sys/class/devfreq/fb000000.gpu/load', measure: 'duty_cycle' },
      provides: [{ tag: 'gpu.usage', sample: 'freq_hz' }],
    });
    expectOnlyRule(pack, 4);
  });
});

describe('rule 4 · a binding to *.usage without a declared measure', () => {
  it('binding duty_cycle to a custom name does not count (that is what rule 3 covers)', () => {
    const pack = addReader(basePack(), {
      id: 'gpu',
      kind: 'devfreq_load',
      args: { path: '/sys/class/devfreq/fb000000.gpu/load', measure: 'duty_cycle' },
      provides: [{ tag: 'custom.tiny.duty', sample: 'duty' }],
    });
    expect(errors(validatePack(pack))).toEqual([]);
  });

  it('binding *.usage without a declared measure is reported', () => {
    const pack = addReader(basePack(), {
      id: 'gpu',
      kind: 'devfreq_load',
      args: { path: '/sys/class/devfreq/fb000000.gpu/load' },
      provides: [{ tag: 'gpu.usage', sample: 'duty' }],
    });
    expectOnlyRule(pack, 4);
  });
});

describe('rule 5 · proc_stat must bind usage to cpu.usage', () => {
  it('binding to another tag is reported', () => {
    const pack = basePack();
    pack.readers[0].provides = [{ tag: 'cpu.core.0.usage', sample: 'core.0.usage' }];
    expectOnlyRule(pack, 5);
  });
});

describe('rule 6 · provides[].sample must be a sample the kind can produce', () => {
  it('a sample that does not exist is reported', () => {
    const pack = addReader(basePack(), {
      id: 'mem',
      kind: 'meminfo',
      args: { path: '/proc/meminfo' },
      provides: [{ tag: 'mem.usage', sample: 'nosuch' }],
    });
    expectOnlyRule(pack, 6);
  });

  it('a kind that does not exist is reported as well', () => {
    const pack = addReader(basePack(), {
      id: 'x',
      kind: 'nosuchkind',
      args: {},
      provides: [{ tag: 'mem.usage', sample: 'value' }],
    });
    expectOnlyRule(pack, 6);
  });
});

describe('rule 7 · the number of * in the tag and in the sample must agree', () => {
  it('a mismatch in the counts is reported', () => {
    const pack = addReader(basePack(), {
      id: 'mem',
      kind: 'meminfo',
      args: { path: '/proc/meminfo' },
      provides: [{ tag: 'cpu.core.*.cluster', sample: 'usage' }],
    });
    expectOnlyRule(pack, 7);
  });
});

describe('rule 8 · a parameter declared by the reader must exist in the schema of the kind', () => {
  it('a misspelled parameter name is reported', () => {
    const pack = basePack();
    pack.readers[0].args = {
      stat_path: '/proc/stat',
      cpuinfo_path: '/proc/cpuinfo',
      stat_pathh: '/proc/stat',
    };
    expectOnlyRule(pack, 8);
  });
});

describe('rule 8 · the value of a parameter must also fit the schema of the kind', () => {
  it('an **enum value that is not in the list** is reported (a misspelled measure, a misspelled format)', () => {
    // The other half of "measure is not optional": **it may only be one of the two values**.
    // Letting a misspelled value through means a duty cycle is published as a utilisation figure.
    const pack = addReader(basePack(), {
      id: 'gpu',
      kind: 'devfreq_load',
      args: { path: '/sys/class/devfreq/fb000000.gpu/load', measure: 'utilzation' },
      provides: [{ tag: 'custom.tiny.duty', sample: 'duty' }],
    });
    expectOnlyRule(pack, 8);
  });

  it('a misspelled format in file_read is reported as well', () => {
    const pack = addReader(basePack(), {
      id: 'fr',
      kind: 'file_read',
      args: { path: '/x', format: 'int' },
      provides: [{ tag: 'custom.tiny.v', sample: 'value' }],
    });
    expectOnlyRule(pack, 8);
  });
});

describe('rule 9 · a required parameter may not be missing', () => {
  it('a missing required parameter is reported', () => {
    const pack = basePack();
    pack.readers[0].args = { stat_path: '/proc/stat' };
    const errs = errors(validatePack(pack));
    expect(errs.some((e) => e.rule === 9)).toBe(true);
  });

  it('none of the oneOf parameters is given is reported (path/glob of file_read)', () => {
    const pack = addReader(basePack(), {
      id: 'fr',
      kind: 'file_read',
      args: { format: 'integer' },
      provides: [{ tag: 'custom.tiny.v', sample: 'value' }],
    });
    const errs = errors(validatePack(pack));
    expect(errs.some((e) => e.rule === 9)).toBe(true);
  });
});

describe('rule 10 · an unknown top-level field is reported (enforced by the loader)', () => {
  it('the loader stops an unknown top-level field', () => {
    const yaml = `
apiVersion: devboard/v1
kind: BoardPack
id: tiny
name: x
version: 1.0.0
requirez:
  transports: [adb]
requires:
  transports: [adb]
  capabilities: [exec]
poll_groups: []
readers: []
custom: []
actions: []
`;
    expect(() => parseBoardPack(yaml, 'tiny/board.yaml')).toThrow(/requirez/);
  });
});

describe('rule 11 · match.models must not be empty; match.mode may only be exact or substring', () => {
  it('empty models is reported', () => {
    const pack = basePack();
    pack.match = { mode: 'exact', models: [] };
    expectOnlyRule(pack, 11);
  });

  it('an invalid mode is reported', () => {
    const pack = basePack();
    pack.match = { mode: 'fuzzy', models: ['X'] };
    expectOnlyRule(pack, 11);
  });
});

describe('rule 12 · the readback.tag of an action must be a tag this pack offers', () => {
  it('pointing at a tag that does not exist is reported', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'echo 1',
      readback: tagReadback('cpu.nosuch'),
    });
    expectOnlyRule(pack, 12);
  });

  it('pointing at a tag this pack offers is valid', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'echo 1',
      readback: tagReadback('cpu.usage'),
    });
    expect(errors(validatePack(pack))).toEqual([]);
  });
});

describe('rule 13 · every {param} in a command and in a readback must be declared', () => {
  it('an undeclared placeholder in a command is reported', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'echo {valu} > /tmp/x',
      readback: tagReadback('cpu.usage'),
    });
    expectOnlyRule(pack, 13);
  });
});

describe('rule 14 · a parameter that is declared but never used is dead', () => {
  it('a dead parameter is reported', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      params: { unused: { type: 'integer', min: 0, max: 1 } },
      command: 'echo 1',
      readback: tagReadback('cpu.usage'),
    });
    expectOnlyRule(pack, 14);
  });
});

describe('rule 15 · the readback form of a destructive action may not be command_ok or none', () => {
  it('using command_ok is reported', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'destructive',
      command: 'echo 1',
      readback: { kind: 'command_ok' },
    });
    expectOnlyRule(pack, 15);
  });

  it('using none is reported', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'destructive',
      command: 'echo 1',
      readback: { kind: 'none', consequence: 'does nothing' },
    });
    expectOnlyRule(pack, 15);
  });

  it('using verify is valid', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'destructive',
      command: 'reboot',
      readback: { kind: 'verify', command: 'uptime -s', timeout_ms: 60000 },
    });
    expect(errors(validatePack(pack))).toEqual([]);
  });
});

describe('rule 16 · a command that hits the danger floor must be declared destructive', () => {
  it('declaring reboot as reversible is reported', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'reboot',
      readback: tagReadback('cpu.usage'),
    });
    expectOnlyRule(pack, 16);
  });

  it('dd writing to a block device is reported', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'dd if=/dev/zero of=/dev/mmcblk0 bs=1M',
      readback: tagReadback('cpu.usage'),
    });
    expectOnlyRule(pack, 16);
  });

  it('rm -rf / is reported', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'rm -rf /',
      readback: tagReadback('cpu.usage'),
    });
    expectOnlyRule(pack, 16);
  });

  it('mkfs.ext4 is reported (it is another spelling of mkfs)', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'mkfs.ext4 /dev/mmcblk0',
      readback: tagReadback('cpu.usage'),
    });
    expectOnlyRule(pack, 16);
  });

  it('a **harmless spelling such as erase_cache does not match** (prefix matching would manufacture false positives)', () => {
    // The contract gives no examples of an erase/burn prefix, while `erase_cache`
    // and `burn_count` are **harmless** common names; calling them destructive
    // would be a **false positive**, not the closing of a hole.
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'erase_cache /tmp/x',
      readback: tagReadback('cpu.usage'),
    });
    expect(errors(validatePack(pack))).toEqual([]);
  });

  it('an **absolute path matches as well** (/sbin/reboot)', () => {
    // The contract §5.2.1 says "the tokens must be equal", but real invocations almost
    // always carry an absolute path; a literal implementation leaves the floor empty against real usage.
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: '/sbin/reboot',
      readback: tagReadback('cpu.usage'),
    });
    expectOnlyRule(pack, 16);
  });

  it('**rm -rf /* matches as well** (after the glob expands it is the root directory)', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'rm -rf /*',
      readback: tagReadback('cpu.usage'),
    });
    expectOnlyRule(pack, 16);
  });

  it('upgrade_status.sh does **not** match upgrade (the tokens must be equal)', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: './upgrade_status.sh',
      readback: tagReadback('cpu.usage'),
    });
    expect(errors(validatePack(pack))).toEqual([]);
  });
});

describe('rule 17 · every reader must belong to exactly one poll group', () => {
  it('belonging to no group is reported', () => {
    const pack = basePack();
    pack.poll_groups[0].readers = [];
    expectOnlyRule(pack, 17);
  });

  it('belonging to two groups is reported', () => {
    const pack = basePack();
    pack.poll_groups.push({ id: 'slow', interval_ms: 2000, readers: ['cpu'] });
    expectOnlyRule(pack, 17);
  });
});

describe('rule 18 · the interval_ms of a poll group may not be below 200', () => {
  it('an interval that is too small is reported', () => {
    const pack = basePack();
    pack.poll_groups[0].interval_ms = 100;
    expectOnlyRule(pack, 18);
  });
});

describe('rule 19 · the presence of exec_regex or script produces a warning', () => {
  it('exec_regex produces a warning (not an error)', () => {
    const pack = addReader(basePack(), {
      id: 'up',
      kind: 'exec_regex',
      args: { command: 'cat /proc/uptime', pattern: '^([0-9.]+)' },
      provides: [{ tag: 'custom.tiny.uptime', sample: 'value' }],
    });
    const issues = validatePack(pack);
    const warns = issues.filter((i) => i.severity === 'warning');
    expect(warns.some((w) => w.rule === 19)).toBe(true);
    expect(errors(issues)).toEqual([]);
  });
});

describe('rule 28 · the command a reader uses to collect data may not hit the danger floor', () => {
  it('**a command of exec_regex that hits the floor is reported** (the board pack takes effect directly — this has to be stopped here)', () => {
    const pack = addReader(basePack(), {
      id: 'wipe',
      kind: 'exec_regex',
      args: { command: 'rm -rf /', pattern: '^x' },
      provides: [{ tag: 'custom.tiny.wipe', sample: 'value' }],
    });
    expectOnlyRule(pack, 28);
  });

  it('**a harmless command is not reported** (the escape hatch has to remain usable)', () => {
    const pack = addReader(basePack(), {
      id: 'up',
      kind: 'exec_regex',
      args: { command: 'cat /proc/uptime', pattern: '^([0-9.]+)' },
      provides: [{ tag: 'custom.tiny.uptime', sample: 'value' }],
    });
    expect(errors(validatePack(pack))).toEqual([]);
  });
});

describe('rule 29 · the argument values of a reader may not contain shell metacharacters', () => {
  it('a **`;` inside a value is reported** (it would concatenate a second command)', () => {
    const pack = addReader(basePack(), {
      id: 'x',
      kind: 'file_read',
      args: { path: '/tmp/x; rm -rf /' },
      provides: [{ tag: 'custom.tiny.x', sample: 'value' }],
    });
    expectOnlyRule(pack, 29);
  });

  it('**the command and the pattern of `exec_regex` are exempt** (they are not paths)', () => {
    const pack = addReader(basePack(), {
      id: 'up',
      kind: 'exec_regex',
      args: { command: 'cat /proc/uptime', pattern: '^([0-9.]+)' },
      provides: [{ tag: 'custom.tiny.uptime', sample: 'value' }],
    });
    expect(errors(validatePack(pack))).toEqual([]);
  });
});

describe('rule 30 · the command of exec_regex may not be an interpreter wrapper', () => {
  it('**`bash -c ...` is reported** (the wrapper bypasses the floor)', () => {
    const pack = addReader(basePack(), {
      id: 'wipe',
      kind: 'exec_regex',
      args: { command: "bash -c 'rm -rf /'", pattern: '^x' },
      provides: [{ tag: 'custom.tiny.wipe', sample: 'value' }],
    });
    expectOnlyRule(pack, 30);
  });

  it('**an ordinary read-only command is let through**', () => {
    const pack = addReader(basePack(), {
      id: 'up',
      kind: 'exec_regex',
      args: { command: 'cat /proc/uptime', pattern: '^([0-9.]+)' },
      provides: [{ tag: 'custom.tiny.uptime', sample: 'value' }],
    });
    expect(errors(validatePack(pack))).toEqual([]);
  });
});

describe('rule 31 · the script kind may not be used in a board pack', () => {
  it('**using script is reported** (it executes a body, and the floor cannot see it)', () => {
    const pack = addReader(basePack(), {
      id: 'sc',
      kind: 'script',
      args: { path: './sc.sh', interpreter: '/bin/sh' },
      provides: [{ tag: 'custom.tiny.sc', sample: 'value' }],
    });
    expectOnlyRule(pack, 31);
  });
});

describe('rule 20 · the type of a param is a closed set; an enum needs non-empty values; a string needs maxLength', () => {
  it('an invalid type is reported', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      params: { v: { type: 'strng' as never } },
      command: 'echo {v}',
      readback: tagReadback('cpu.usage'),
    });
    expectOnlyRule(pack, 20);
  });

  it('an enum without values is reported', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      params: { v: { type: 'enum' } },
      command: 'echo {v}',
      readback: tagReadback('cpu.usage'),
    });
    expectOnlyRule(pack, 20);
  });

  it('a string without maxLength is reported', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      params: { v: { type: 'string' } },
      command: 'echo {v}',
      readback: tagReadback('cpu.usage'),
    });
    expectOnlyRule(pack, 20);
  });
});

describe('rule 21 · a placeholder in a command template may not carry its own quotes', () => {
  it('a placeholder that carries quotes is reported', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      params: { v: { type: 'string', maxLength: 8 } },
      command: "echo '{v}'",
      readback: tagReadback('cpu.usage'),
    });
    expectOnlyRule(pack, 21);
  });
});

describe('rule 22 · a guard must be a subset of the range declared by the params', () => {
  it('a guard outside the range of the params is reported', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      params: { v: { type: 'integer', min: 0, max: 255 } },
      guard: { v: { min: 0, max: 999 } },
      command: 'echo {v}',
      readback: tagReadback('cpu.usage'),
    });
    expectOnlyRule(pack, 22);
  });
});

describe('rule 23 · readback.kind belongs to a closed enumeration', () => {
  it('an unknown kind is reported', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'echo 1',
      readback: { kind: 'whatever' },
    });
    expectOnlyRule(pack, 23);
  });
});

describe('rule 24 · danger_floor_version must be a known version', () => {
  it('an unknown version is reported', () => {
    const pack = basePack();
    pack.danger_floor_version = 2;
    expectOnlyRule(pack, 24);
  });

  it('version 1 is valid', () => {
    const pack = basePack();
    pack.danger_floor_version = 1;
    expect(errors(validatePack(pack))).toEqual([]);
  });
});

describe('rule 25 · a value of requires.capabilities must belong to a closed vocabulary', () => {
  it('an unknown capability name is reported', () => {
    const pack = basePack();
    pack.requires.capabilities = ['shellh'];
    expectOnlyRule(pack, 25);
  });
});

describe('rule 26 · a value of requires.capabilities must belong to the set of implemented capabilities', () => {
  it('declaring stream is reported (the Stream contract is not written yet, so it cannot be offered)', () => {
    const pack = basePack();
    pack.requires.capabilities = ['exec', 'stream'];
    expectOnlyRule(pack, 26);
  });
});

describe('rule 27 · every action must have a readback; none must carry a non-empty consequence', () => {
  it('a missing readback is reported (**destructive is no exception**)', () => {
    // This one **overrides** "destructive needs a readback as well", so it reports
    // rule 27 and not rule 15 (rule 15 covers a **wrong form**).
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'destructive',
      command: 'reboot',
    });
    expectOnlyRule(pack, 27);
  });

  it('a missing readback is reported for reversible as well', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'echo 1',
    });
    expectOnlyRule(pack, 27);
  });

  it('a none without a consequence is reported', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'echo 1',
      readback: { kind: 'none' },
    });
    expectOnlyRule(pack, 27);
  });

  it('a none whose consequence is an empty string is reported', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'echo 1',
      readback: { kind: 'none', consequence: '' },
    });
    expectOnlyRule(pack, 27);
  });

  it('a none with a non-empty consequence is valid (reversible)', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'echo 1',
      readback: { kind: 'none', consequence: 'lights the on-board LED for about 1 second' },
    });
    expect(errors(validatePack(pack))).toEqual([]);
  });

  it('**an action that uses none records one warning for each of them**', () => {
    // "This visibility is the main line of defence" — without the warning, the defence is not in place.
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'echo 1',
      readback: { kind: 'none', consequence: 'lights the on-board LED for about 1 second' },
    });
    const issues = validatePack(pack);
    const warns = issues.filter((i) => i.severity === 'warning');
    expect(warns.some((w) => w.rule === 27)).toBe(true);
  });
});

describe('validating a real pack', () => {
  it('rk3588-atk reports no error', async () => {
    const { loadBoardPack } = await import('../../src/main/tags/pack');
    const { join } = await import('node:path');
    const pack = loadBoardPack(join(__dirname, '../../profiles/boards/rk3588-atk'));
    const errs = errors(validatePack(pack));
    expect(errs.map((e) => `${e.rule}@${e.path}: ${e.message}`)).toEqual([]);
  });
});

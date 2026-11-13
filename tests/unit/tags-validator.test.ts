import { describe, it, expect } from 'vitest';
import { validatePack, type ValidationIssue } from '../../src/main/tags/validator';
import { parseBoardPack } from '../../src/main/tags/pack';
import type { ActionDef, BoardPack, ReaderDef } from '../../src/main/tags/schema';

/**
 * 27 条校验规则。
 *
 * ── 测法：每个合成包**只违反一条规则** ──
 *
 * 「红得对原因」比「红」更重要：一个同时违反三条规则的合成包，
 * 只能证明「校验器报错了」，**证明不了「规则 N 被实现了」**。
 * 所以每条规则都断言：**恰好一条 error，且规则号就是 N**。
 *
 * 真实包保真，合成包保规则覆盖（`docs/16` §3.7）。
 */

/**
 * 一个**合法**的最小包。每条规则的用例都从它改出来。
 *
 * 它的 cpu reader 绑两个 tag（`cpu.usage` 与 `cpu.core.*.usage`），
 * 因为规则 2/7 要用「模式」那一侧。
 */
function basePack(): BoardPack {
  return {
    apiVersion: 'devboard/v1',
    kind: 'BoardPack',
    id: 'tiny',
    name: '最小包',
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

/** 把一个 reader 加进某个组 */
function addReader(pack: BoardPack, reader: ReaderDef, group = 'fast'): BoardPack {
  pack.readers.push(reader);
  pack.poll_groups.find((g) => g.id === group)!.readers.push(reader.id);
  return pack;
}

/** 加一个动作 */
function addAction(pack: BoardPack, action: ActionDef): BoardPack {
  pack.actions.push(action);
  return pack;
}

/** 只报 error */
function errors(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => i.severity === 'error');
}

/** 断言：恰好一条 error，规则号是 n */
function expectOnlyRule(pack: BoardPack, n: number): void {
  const errs = errors(validatePack(pack));
  const ofRule = errs.filter((i) => i.rule === n);
  expect(
    ofRule.length,
    `规则 ${n} 应该报一条 error，实际报了 ${ofRule.length} 条；全部 error：${JSON.stringify(
      errs.map((e) => `${e.rule}@${e.path}`),
    )}`,
  ).toBe(1);
  expect(
    errs.length,
    `这个合成包应该**只**违反规则 ${n}，实际还报了：${JSON.stringify(
      errs.filter((e) => e.rule !== n).map((e) => `${e.rule}@${e.path}: ${e.message}`),
    )}`,
  ).toBe(1);
}

/** 一个走形式 1（读一个 tag）的回读。**不写 `kind`**——契约 §4.4 就是这么说的 */
function tagReadback(tag: string): ActionDef['readback'] {
  return { tag };
}

describe('基准包', () => {
  it('合法包零 error', () => {
    expect(errors(validatePack(basePack()))).toEqual([]);
  });
});

describe('规则 1 · tag 必须落在核心词表或 custom.<本包 id>. 下', () => {
  it('不在词表里的 tag 报错', () => {
    const pack = addReader(basePack(), {
      id: 'mem',
      kind: 'meminfo',
      args: { path: '/proc/meminfo' },
      provides: [{ tag: 'cpu.temperature', sample: 'usage' }],
    });
    expectOnlyRule(pack, 1);
  });

  it('别的包的 custom 命名空间不算', () => {
    const pack = addReader(basePack(), {
      id: 'mem',
      kind: 'meminfo',
      args: { path: '/proc/meminfo' },
      provides: [{ tag: 'custom.other.thing', sample: 'usage' }],
    });
    expectOnlyRule(pack, 1);
  });

  it('本包的 custom 命名空间合法', () => {
    const pack = addReader(basePack(), {
      id: 'mem',
      kind: 'meminfo',
      args: { path: '/proc/meminfo' },
      provides: [{ tag: 'custom.tiny.thing', sample: 'usage' }],
    });
    expect(errors(validatePack(pack))).toEqual([]);
  });
});

describe('规则 2 · 两个 reader 的 tag 模式不得重叠', () => {
  it('两个 reader 提供同一个 tag 报错', () => {
    const pack = addReader(basePack(), {
      id: 'cpu2',
      kind: 'proc_stat',
      args: { stat_path: '/proc/stat', cpuinfo_path: '/proc/cpuinfo' },
      provides: [{ tag: 'cpu.usage', sample: 'usage' }],
    });
    expectOnlyRule(pack, 2);
  });

  it('模式重叠也报错（cpu.core.*.usage 与 cpu.core.3.usage）', () => {
    const pack = addReader(basePack(), {
      id: 'mem',
      kind: 'meminfo',
      args: { path: '/proc/meminfo' },
      provides: [{ tag: 'cpu.core.3.usage', sample: 'usage' }],
    });
    expectOnlyRule(pack, 2);
  });
});

describe('规则 3 · devfreq_load 的 duty_cycle 不得绑到任何 *.usage', () => {
  it('duty_cycle 绑 gpu.usage 报错', () => {
    const pack = addReader(basePack(), {
      id: 'gpu',
      kind: 'devfreq_load',
      args: { path: '/sys/class/devfreq/fb000000.gpu/load', measure: 'duty_cycle' },
      provides: [{ tag: 'gpu.usage', sample: 'duty' }],
    });
    // **规则 3 与 4 同时报**：两条都是真的——
    // 3 说「duty 是占空比，不能叫 usage」，4 说「叫 usage 必须声明 utilization」。
    const errs = errors(validatePack(pack));
    expect(errs.filter((e) => e.rule === 3)).toHaveLength(1);
    expect(errs.filter((e) => e.rule === 4)).toHaveLength(1);
  });
});

describe('规则 4 · 绑到 *.usage 必须声明 measure: utilization', () => {
  it('**measure 拼错了**也要报（utilzation 不是 utilization）', () => {
    // 契约规则 4 的判据是「**等于 utilization**」，不是「非空」。
    // 拼错的 measure 一路放行 = **占空比被发布成利用率**——
    // 那是这个工程最在意的那类 bug（假数比 0 更坏）。
    const pack = addReader(basePack(), {
      id: 'gpu',
      kind: 'devfreq_load',
      args: { path: '/sys/class/devfreq/fb000000.gpu/load', measure: 'utilzation' },
      provides: [{ tag: 'gpu.usage', sample: 'duty' }],
    });
    // 规则 4（值不是 utilization）与规则 8（取值不在 enum 清单里）**都报**——
    // 两条都是真的，且各自指向不同的修法。
    const errs = errors(validatePack(pack));
    expect(errs.filter((e) => e.rule === 4)).toHaveLength(1);
    expect(errs.filter((e) => e.rule === 8)).toHaveLength(1);
  });

  it('measure 是 duty_cycle 但绑的不是 duty → 也报规则 4', () => {
    const pack = addReader(basePack(), {
      id: 'gpu',
      kind: 'devfreq_load',
      args: { path: '/sys/class/devfreq/fb000000.gpu/load', measure: 'duty_cycle' },
      provides: [{ tag: 'gpu.usage', sample: 'freq_hz' }],
    });
    expectOnlyRule(pack, 4);
  });
});

describe('规则 4 · 绑到 *.usage 却没有声明 measure', () => {
  it('duty_cycle 绑到 custom 名字不算（那是规则 3 管的事）', () => {
    const pack = addReader(basePack(), {
      id: 'gpu',
      kind: 'devfreq_load',
      args: { path: '/sys/class/devfreq/fb000000.gpu/load', measure: 'duty_cycle' },
      provides: [{ tag: 'custom.tiny.duty', sample: 'duty' }],
    });
    expect(errors(validatePack(pack))).toEqual([]);
  });

  it('没声明 measure 就绑 *.usage 报错', () => {
    const pack = addReader(basePack(), {
      id: 'gpu',
      kind: 'devfreq_load',
      args: { path: '/sys/class/devfreq/fb000000.gpu/load' },
      provides: [{ tag: 'gpu.usage', sample: 'duty' }],
    });
    expectOnlyRule(pack, 4);
  });
});

describe('规则 5 · proc_stat 必须把 usage 绑到 cpu.usage', () => {
  it('绑到别的 tag 报错', () => {
    const pack = basePack();
    pack.readers[0].provides = [{ tag: 'cpu.core.0.usage', sample: 'core.0.usage' }];
    expectOnlyRule(pack, 5);
  });
});

describe('规则 6 · provides[].sample 必须是该 kind 能产出的 sample', () => {
  it('不存在的 sample 报错', () => {
    const pack = addReader(basePack(), {
      id: 'mem',
      kind: 'meminfo',
      args: { path: '/proc/meminfo' },
      provides: [{ tag: 'mem.usage', sample: 'nosuch' }],
    });
    expectOnlyRule(pack, 6);
  });

  it('kind 本身不存在也报错', () => {
    const pack = addReader(basePack(), {
      id: 'x',
      kind: 'nosuchkind',
      args: {},
      provides: [{ tag: 'mem.usage', sample: 'value' }],
    });
    expectOnlyRule(pack, 6);
  });
});

describe('规则 7 · tag 与 sample 的 * 数量必须一致', () => {
  it('数量不一致报错', () => {
    const pack = addReader(basePack(), {
      id: 'mem',
      kind: 'meminfo',
      args: { path: '/proc/meminfo' },
      provides: [{ tag: 'cpu.core.*.cluster', sample: 'usage' }],
    });
    expectOnlyRule(pack, 7);
  });
});

describe('规则 8 · reader 声明的参数必须在 kind 的 schema 里存在', () => {
  it('拼错的参数名报错', () => {
    const pack = basePack();
    pack.readers[0].args = {
      stat_path: '/proc/stat',
      cpuinfo_path: '/proc/cpuinfo',
      stat_pathh: '/proc/stat',
    };
    expectOnlyRule(pack, 8);
  });
});

describe('规则 8 · 参数的取值也要合 kind 的 schema', () => {
  it('**enum 的取值不在清单里**要报错（measure 拼错、format 拼错）', () => {
    // 「measure 不是可选的」的另一半：**它只能是那两个值之一**。
    // 拼错的值一路放行 = 占空比被发布成利用率。
    const pack = addReader(basePack(), {
      id: 'gpu',
      kind: 'devfreq_load',
      args: { path: '/sys/class/devfreq/fb000000.gpu/load', measure: 'utilzation' },
      provides: [{ tag: 'custom.tiny.duty', sample: 'duty' }],
    });
    expectOnlyRule(pack, 8);
  });

  it('file_read 的 format 拼错也报错', () => {
    const pack = addReader(basePack(), {
      id: 'fr',
      kind: 'file_read',
      args: { path: '/x', format: 'int' },
      provides: [{ tag: 'custom.tiny.v', sample: 'value' }],
    });
    expectOnlyRule(pack, 8);
  });
});

describe('规则 9 · 必填参数不能缺', () => {
  it('缺必填参数报错', () => {
    const pack = basePack();
    pack.readers[0].args = { stat_path: '/proc/stat' };
    const errs = errors(validatePack(pack));
    expect(errs.some((e) => e.rule === 9)).toBe(true);
  });

  it('oneOf 参数一个都不给报错（file_read 的 path/glob）', () => {
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

describe('规则 10 · 未知顶层字段报错（由加载器执行）', () => {
  it('加载器拦下未知顶层字段', () => {
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

describe('规则 11 · match.models 非空；match.mode 只能是 exact/substring', () => {
  it('models 空报错', () => {
    const pack = basePack();
    pack.match = { mode: 'exact', models: [] };
    expectOnlyRule(pack, 11);
  });

  it('mode 非法报错', () => {
    const pack = basePack();
    pack.match = { mode: 'fuzzy', models: ['X'] };
    expectOnlyRule(pack, 11);
  });
});

describe('规则 12 · action 的 readback.tag 必须是本包提供的 tag', () => {
  it('指向不存在的 tag 报错', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'echo 1',
      readback: tagReadback('cpu.nosuch'),
    });
    expectOnlyRule(pack, 12);
  });

  it('指向本包提供的 tag 是合法的', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'echo 1',
      readback: tagReadback('cpu.usage'),
    });
    expect(errors(validatePack(pack))).toEqual([]);
  });
});

describe('规则 13 · 命令与回读里的 {param} 都必须声明', () => {
  it('命令里的占位没声明报错', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'echo {valu} > /tmp/x',
      readback: tagReadback('cpu.usage'),
    });
    expectOnlyRule(pack, 13);
  });
});

describe('规则 14 · 声明了但没用的参数是死参数', () => {
  it('死参数报错', () => {
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

describe('规则 15 · destructive 的回读形式不得是 command_ok / none', () => {
  it('用 command_ok 报错', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'destructive',
      command: 'echo 1',
      readback: { kind: 'command_ok' },
    });
    expectOnlyRule(pack, 15);
  });

  it('用 none 报错', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'destructive',
      command: 'echo 1',
      readback: { kind: 'none', consequence: '什么也不做' },
    });
    expectOnlyRule(pack, 15);
  });

  it('用 verify 是合法的', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'destructive',
      command: 'reboot',
      readback: { kind: 'verify', command: 'uptime -s', timeout_ms: 60000 },
    });
    expect(errors(validatePack(pack))).toEqual([]);
  });
});

describe('规则 16 · 命中危险地板的命令必须声明为 destructive', () => {
  it('reboot 声明成 reversible 报错', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'reboot',
      readback: tagReadback('cpu.usage'),
    });
    expectOnlyRule(pack, 16);
  });

  it('dd 写块设备报错', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'dd if=/dev/zero of=/dev/mmcblk0 bs=1M',
      readback: tagReadback('cpu.usage'),
    });
    expectOnlyRule(pack, 16);
  });

  it('rm -rf / 报错', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'rm -rf /',
      readback: tagReadback('cpu.usage'),
    });
    expectOnlyRule(pack, 16);
  });

  it('mkfs.ext4 报错（它是 mkfs 的同义写法）', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'mkfs.ext4 /dev/mmcblk0',
      readback: tagReadback('cpu.usage'),
    });
    expectOnlyRule(pack, 16);
  });

  it('upgrade_status.sh **不**命中 upgrade（词元相等）', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: './upgrade_status.sh',
      readback: tagReadback('cpu.usage'),
    });
    expect(errors(validatePack(pack))).toEqual([]);
  });
});

describe('规则 17 · 每个 reader 必须属于恰好一个 poll group', () => {
  it('不在任何组里报错', () => {
    const pack = basePack();
    pack.poll_groups[0].readers = [];
    expectOnlyRule(pack, 17);
  });

  it('进了两个组报错', () => {
    const pack = basePack();
    pack.poll_groups.push({ id: 'slow', interval_ms: 2000, readers: ['cpu'] });
    expectOnlyRule(pack, 17);
  });
});

describe('规则 18 · poll group 的 interval_ms 不低于 200', () => {
  it('间隔太小报错', () => {
    const pack = basePack();
    pack.poll_groups[0].interval_ms = 100;
    expectOnlyRule(pack, 18);
  });
});

describe('规则 19 · exec_regex / script 存在时打印警告', () => {
  it('exec_regex 产出 warning（不是 error）', () => {
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

describe('规则 20 · params 的 type 封闭；enum 要非空 values；string 要 maxLength', () => {
  it('type 非法报错', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      params: { v: { type: 'strng' as never } },
      command: 'echo {v}',
      readback: tagReadback('cpu.usage'),
    });
    expectOnlyRule(pack, 20);
  });

  it('enum 没有 values 报错', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      params: { v: { type: 'enum' } },
      command: 'echo {v}',
      readback: tagReadback('cpu.usage'),
    });
    expectOnlyRule(pack, 20);
  });

  it('string 没有 maxLength 报错', () => {
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

describe('规则 21 · command 模板里的占位不得自带引号', () => {
  it('占位自带引号报错', () => {
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

describe('规则 22 · guard 必须是 params 声明域的子集', () => {
  it('guard 超出 params 的域报错', () => {
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

describe('规则 23 · readback.kind 属于封闭枚举', () => {
  it('未知的 kind 报错', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'echo 1',
      readback: { kind: 'whatever' },
    });
    expectOnlyRule(pack, 23);
  });
});

describe('规则 24 · danger_floor_version 必须是已知版本', () => {
  it('未知版本报错', () => {
    const pack = basePack();
    pack.danger_floor_version = 2;
    expectOnlyRule(pack, 24);
  });

  it('版本 1 合法', () => {
    const pack = basePack();
    pack.danger_floor_version = 1;
    expect(errors(validatePack(pack))).toEqual([]);
  });
});

describe('规则 25 · requires.capabilities 的值必须属于封闭词表', () => {
  it('未知的能力名报错', () => {
    const pack = basePack();
    pack.requires.capabilities = ['shellh'];
    expectOnlyRule(pack, 25);
  });
});

describe('规则 26 · requires.capabilities 的值必须属于已实现能力集', () => {
  it('声明 stream 报错（Stream 契约还没写，给不出来）', () => {
    const pack = basePack();
    pack.requires.capabilities = ['exec', 'stream'];
    expectOnlyRule(pack, 26);
  });
});

describe('规则 27 · 每个 action 必须有 readback；none 必须带非空 consequence', () => {
  it('没有 readback 报错（**destructive 也不例外**）', () => {
    // 这一条**覆盖**了「destructive 也要有回读」——
    // 所以它报的是规则 27 而不是规则 15（规则 15 管的是**形式不对**）。
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'destructive',
      command: 'reboot',
    });
    expectOnlyRule(pack, 27);
  });

  it('reversible 也没有 readback 同样报错', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'echo 1',
    });
    expectOnlyRule(pack, 27);
  });

  it('none 没有 consequence 报错', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'echo 1',
      readback: { kind: 'none' },
    });
    expectOnlyRule(pack, 27);
  });

  it('none 的 consequence 是空串报错', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'echo 1',
      readback: { kind: 'none', consequence: '' },
    });
    expectOnlyRule(pack, 27);
  });

  it('none 带非空 consequence 是合法的（reversible）', () => {
    const pack = addAction(basePack(), {
      id: 'a',
      danger: 'reversible',
      command: 'echo 1',
      readback: { kind: 'none', consequence: '点亮板载 LED 约 1 秒' },
    });
    expect(errors(validatePack(pack))).toEqual([]);
  });
});

describe('校验真实包', () => {
  it('rk3588-atk 零 error', async () => {
    const { loadBoardPack } = await import('../../src/main/tags/pack');
    const { join } = await import('node:path');
    const pack = loadBoardPack(join(__dirname, '../../profiles/boards/rk3588-atk'));
    const errs = errors(validatePack(pack));
    expect(errs.map((e) => `${e.rule}@${e.path}: ${e.message}`)).toEqual([]);
  });
});

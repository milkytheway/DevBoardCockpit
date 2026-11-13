import { describe, it, expect } from 'vitest';
import { judgeReader, resolvePackDir, describeRequires, probeHint } from '../../src/main/tags/probe';
import type { TagReading } from '../../src/shared/tag-reading';

/**
 * 探针的**判定逻辑**（M4 的判据）。
 *
 * 「`probe:board` 对 `rk3588-atk` 全绿」是 M4 的验收标准，
 * 而「全绿」这个词必须有一个**机械的判据**——
 * 不然「全绿」就只是一个人看着屏幕说「好像都对了」。
 *
 * 一个 reader 绿的条件：
 * 1. 它产出的**每一个** tag 都在包里声明过（**不多**）；
 * 2. 包里声明的**每一个不带通配符的** tag 都拿到了（**不少**）；
 * 3. 这些 tag 的状态**都是 `ok`**（`pending` 也不算——
 *    探针要的是「取到了真值」，不是「取到了但还没算出来」）。
 */

function reading(tag: string, value: unknown = 1, status: TagReading['status'] = 'ok'): TagReading {
  return { tag, value: value as TagReading['value'], unit: 'percent', status, at: 1, seq: 1 };
}

describe('judgeReader · 一个 reader 绿的条件', () => {
  const exp = {
    readerId: 'cpu',
    kind: 'proc_stat',
    declaredTags: ['cpu.usage', 'cpu.core.*.usage'],
  };

  it('声明的 tag 全部拿到、状态都是 ok → 绿', () => {
    const report = judgeReader(exp, [reading('cpu.usage'), reading('cpu.core.0.usage')]);
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
  });

  it('**少一个 tag** → 红', () => {
    const report = judgeReader(exp, [reading('cpu.usage')]);
    expect(report.ok).toBe(false);
    expect(report.problems.join('\n')).toContain('cpu.core.*.usage');
  });

  it('**多一个 tag**（包里没声明却产出了）→ 红', () => {
    const report = judgeReader(exp, [
      reading('cpu.usage'),
      reading('cpu.core.0.usage'),
      reading('cpu.secret'),
    ]);
    expect(report.ok).toBe(false);
    expect(report.problems.join('\n')).toContain('cpu.secret');
  });

  it('状态不是 ok → 红（**pending 也不算**）', () => {
    const pending = judgeReader(exp, [
      reading('cpu.usage', null, 'pending'),
      reading('cpu.core.0.usage'),
    ]);
    expect(pending.ok).toBe(false);

    const unavailable = judgeReader(exp, [
      reading('cpu.usage', null, 'unavailable'),
      reading('cpu.core.0.usage'),
    ]);
    expect(unavailable.ok).toBe(false);
  });

  it('一个 tag 都没拿到 → 红', () => {
    const report = judgeReader(exp, []);
    expect(report.ok).toBe(false);
  });

  it('**通配符的 tag 不要求「一个不多一个不少」**——有几个算几个', () => {
    // 8 核的板子出 8 个 cpu.core.N.usage —— 包里只声明了一个模式
    const readings = [reading('cpu.usage')];
    for (let i = 0; i < 8; i += 1) readings.push(reading(`cpu.core.${i}.usage`));
    const report = judgeReader(exp, readings);
    expect(report.ok).toBe(true);
  });

  it('报告里带上每个 tag 的值（给人看的）', () => {
    const report = judgeReader(exp, [reading('cpu.usage', 12.5), reading('cpu.core.0.usage', 3)]);
    expect(report.tags).toHaveLength(2);
    expect(report.tags[0]).toMatchObject({ tag: 'cpu.usage', value: 12.5 });
  });

  it('报告里带上 reader 的 id 与 kind', () => {
    const report = judgeReader(exp, [reading('cpu.usage'), reading('cpu.core.0.usage')]);
    expect(report.readerId).toBe('cpu');
    expect(report.kind).toBe('proc_stat');
  });
});

describe('resolvePackDir · --pack 认包 id 也认目录路径', () => {
  const BOARDS = '/repo/profiles/boards';

  it('**包 id** → profiles/boards/<id>', () => {
    // 文档（docs/04 §12、包的 README）写的是 `--pack rk3588-atk`（包 id），
    // 实现只认目录路径 → **文档里那条命令跑不起来**。
    expect(resolvePackDir('rk3588-atk', BOARDS)).toBe('/repo/profiles/boards/rk3588-atk');
  });

  it('**目录路径**原样用', () => {
    expect(resolvePackDir('/other/place/rk3588-atk', BOARDS)).toBe('/other/place/rk3588-atk');
    expect(resolvePackDir('profiles/boards/rk3588-atk', BOARDS)).toBe('profiles/boards/rk3588-atk');
  });

  it('不给就用默认包', () => {
    expect(resolvePackDir(undefined, BOARDS)).toBe('/repo/profiles/boards/rk3588-atk');
  });
});

describe('describeRequires · 探针要报出这个字段（docs/06 C9 承诺的消费者）', () => {
  it('把 capabilities 与 transports 都报出来', () => {
    const line = describeRequires({
      apiVersion: 'devboard/v1',
      kind: 'BoardPack',
      id: 'tiny',
      name: 'x',
      version: '1.0.0',
      requires: { transports: ['adb', 'serial'], capabilities: ['shell', 'exec'] },
      poll_groups: [],
      readers: [],
      custom: [],
      actions: [],
    });
    expect(line).toContain('capabilities');
    expect(line).toContain('shell');
    expect(line).toContain('transports');
    expect(line).toContain('adb');
  });
});

describe('probeHint · 探针红了的时候给一句「下一步查什么」', () => {
  const green = {
    packId: 'tiny',
    ok: true,
    readers: [{ readerId: 'cpu', kind: 'proc_stat', tags: [{ tag: 'cpu.usage', value: 1, unit: 'percent', status: 'ok' }], problems: [], ok: true }],
  };
  const allEmpty = {
    packId: 'tiny',
    ok: false,
    readers: [
      { readerId: 'cpu', kind: 'proc_stat', tags: [], problems: ['超时'], ok: false },
      { readerId: 'gpu', kind: 'devfreq_load', tags: [], problems: ['超时'], ok: false },
    ],
  };

  it('全绿时没有提示', () => {
    expect(probeHint(green as never, 'adb')).toBeNull();
  });

  it('**一个数都没出来** → 提示「这条连接没通」，不是「reader 有问题」', () => {
    const hint = probeHint(allEmpty as never, 'adb');
    expect(hint).toBeTruthy();
    expect(hint).toContain('连接');
  });

  it('走**串口**时提示「别的程序独占着那个口」', () => {
    // 这是真机上真踩过的坑：计划 1 验收留下的 serial-server.py 独占着 COM3，
    // **回包被它吃掉**——板子是活的，但应用永远收不到。
    const hint = probeHint(allEmpty as never, 'serial');
    expect(hint).toBeTruthy();
    expect(hint).toContain('COM3');
  });

  it('只有个别 reader 红、别的有数 → 不给「连接没通」的提示', () => {
    const mixed = {
      packId: 'tiny',
      ok: false,
      readers: [
        { readerId: 'cpu', kind: 'proc_stat', tags: [{ tag: 'cpu.usage', value: 1, unit: 'percent', status: 'ok' }], problems: [], ok: true },
        { readerId: 'gpu', kind: 'devfreq_load', tags: [], problems: ['超时'], ok: false },
      ],
    };
    expect(probeHint(mixed as never, 'serial')).toBeNull();
  });
});

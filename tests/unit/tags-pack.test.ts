import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBoardPack, loadBoardPack } from '../../src/main/tags/pack';

/**
 * 板型包的加载器。
 *
 * **为什么要有加载器**：契约里「未知字段必须报错」（规则 10 / 24）——
 * 被静默忽略的字段就是拼错的字段。所以这个模块的核心职责不是「读 YAML」，
 * 而是**逐字段核对**。
 *
 * 用真实包测「真实包能加载」，用合成包测「坏包会被拦下」——
 * **真实包保真，合成包保规则覆盖**（与校验器同一个模式）。
 */

const REPO = join(__dirname, '../..');
const REAL_PACK_DIR = join(REPO, 'profiles/boards/rk3588-atk');

/** 一个最小的合法包（供合成包改造） */
const MINIMAL = `
apiVersion: devboard/v1
kind: BoardPack
id: tiny
name: 最小包
version: 1.0.0
requires:
  transports: [adb]
  capabilities: [exec]
  min_contract: devboard/v1
poll_groups:
  - id: fast
    interval_ms: 1000
    readers: [cpu]
readers:
  - id: cpu
    kind: proc_stat
    args:
      stat_path: /proc/stat
      cpuinfo_path: /proc/cpuinfo
    provides:
      - tag: cpu.usage
        sample: usage
custom: []
actions: []
`;

describe('loadBoardPack · 真实包', () => {
  it('加载仓库里的 rk3588-atk 包', () => {
    const pack = loadBoardPack(REAL_PACK_DIR);
    expect(pack.id).toBe('rk3588-atk');
    expect(pack.apiVersion).toBe('devboard/v1');
    expect(pack.kind).toBe('BoardPack');
    expect(pack.readers).toHaveLength(7);
    expect(pack.custom).toHaveLength(4);
    expect(pack.actions).toHaveLength(3);
  });

  it('requires.capabilities 不含 stream（规则 26：声明了也给不出来）', () => {
    const pack = loadBoardPack(REAL_PACK_DIR);
    expect(pack.requires.capabilities).toEqual(['shell', 'exec', 'files']);
    expect(pack.requires.capabilities).not.toContain('stream');
  });

  it('readers 与 custom 是两个列表（§九）', () => {
    const pack = loadBoardPack(REAL_PACK_DIR);
    expect(pack.custom.map((r) => r.id)).toEqual([
      'backlight',
      'backlight1',
      'npu_devfreq',
      'npu_freq',
    ]);
  });

  it('poll_groups 覆盖全部 reader（规则 17 的前提）', () => {
    const pack = loadBoardPack(REAL_PACK_DIR);
    const grouped = pack.poll_groups.flatMap((g) => g.readers);
    const all = [...pack.readers, ...pack.custom].map((r) => r.id);
    expect(grouped.sort()).toEqual(all.sort());
  });
});

describe('parseBoardPack · 未知字段必须报错（规则 10 / 24）', () => {
  it('未知顶层字段报错，消息里带字段名', () => {
    const yaml = MINIMAL.replace('requires:', 'requirez:');
    expect(() => parseBoardPack(yaml, 'tiny/board.yaml')).toThrow(/requirez/);
  });

  it('未知 reader 字段报错', () => {
    const yaml = MINIMAL.replace('    kind: proc_stat\n', '    kind: proc_stat\n    argz: {}\n');
    expect(() => parseBoardPack(yaml, 'tiny/board.yaml')).toThrow(/argz/);
  });

  it('未知 action 字段报错', () => {
    const yaml = MINIMAL.replace(
      'actions: []',
      'actions:\n  - id: a\n    danger: reversible\n    commnd: "echo 1"',
    );
    expect(() => parseBoardPack(yaml, 'tiny/board.yaml')).toThrow(/commnd/);
  });

  it('未知 provides 字段报错', () => {
    const yaml = MINIMAL.replace('        sample: usage', '        sample: usage\n        targ: cpu.usage');
    expect(() => parseBoardPack(yaml, 'tiny/board.yaml')).toThrow(/targ/);
  });

  it('错误消息说明「可能是拼错的」——这是给人看的提示', () => {
    const yaml = MINIMAL.replace('requires:', 'requirez:');
    expect(() => parseBoardPack(yaml, 'tiny/board.yaml')).toThrow(/拼错/);
  });

  it('错误消息带路径（readers[0] 这种）', () => {
    const yaml = MINIMAL.replace('    kind: proc_stat\n', '    kind: proc_stat\n    argz: {}\n');
    expect(() => parseBoardPack(yaml, 'tiny/board.yaml')).toThrow(/readers\[0\]/);
  });

  it('args 里的参数名**不**被加载器拦下 —— 那是规则 8（校验器）的活', () => {
    // **分工**：加载器只管**结构**（这个字段属于哪一段）；
    // 参数名对不对，要问 kind 的 schema（规则 8）——那是校验器的活。
    // 两件事混在一起，加载器就得依赖 kind 注册表，测试也分不清是谁拦下的。
    const yaml = MINIMAL.replace('      stat_path: /proc/stat', '      stat_pathh: /proc/stat');
    expect(() => parseBoardPack(yaml, 'tiny/board.yaml')).not.toThrow();
  });
});

describe('parseBoardPack · 缺字段与类型不对', () => {
  it('缺 apiVersion 报错，消息里带字段名', () => {
    const yaml = MINIMAL.replace('apiVersion: devboard/v1\n', '');
    expect(() => parseBoardPack(yaml, 'tiny/board.yaml')).toThrow(/缺少必填字段 apiVersion/);
  });

  it('缺 id 报错', () => {
    const yaml = MINIMAL.replace('id: tiny\n', '');
    expect(() => parseBoardPack(yaml, 'tiny/board.yaml')).toThrow(/缺少必填字段 id/);
  });

  it('缺 poll_groups 报错', () => {
    const yaml = MINIMAL.replace(/poll_groups:[\s\S]*?readers: \[cpu\]\n/, '');
    expect(() => parseBoardPack(yaml, 'tiny/board.yaml')).toThrow(/缺少必填字段 poll_groups/);
  });

  it('interval_ms 是字符串报错（类型不对不能当 0）', () => {
    const yaml = MINIMAL.replace('interval_ms: 1000', 'interval_ms: "soon"');
    expect(() => parseBoardPack(yaml, 'tiny/board.yaml')).toThrow(/interval_ms/);
  });

  it('YAML 本身坏掉时报错（不是空包）', () => {
    expect(() => parseBoardPack('apiVersion: [unclosed\n', 'tiny/board.yaml')).toThrow();
  });

  it('空文件报错', () => {
    expect(() => parseBoardPack('', 'tiny/board.yaml')).toThrow();
  });
});

describe('loadBoardPack · 文件不存在', () => {
  it('目录里没有 board.yaml 就报错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'empty-'));
    try {
      expect(() => loadBoardPack(dir)).toThrow(/board\.yaml/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

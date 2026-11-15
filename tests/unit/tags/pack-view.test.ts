import { describe, it, expect } from 'vitest';
import { packView, type PackView } from '../../../src/main/tags/pack-view';
import type { BoardPack } from '../../../src/main/tags/schema';

/**
 * **板型包的脱敏只读投影**（契约 `spec/04` §2.1 / §2.4 ✓ · ADR-D40 ✓）。
 *
 * ── 为什么要有这一层 ──
 *
 * `TagRuntime.pack` 是**私有的** ✓ —— 而 MCP 的读侧工具要看到它 ✓
 * （`list_data_sources` / `describe_tag` / `list_tags` ✓）。
 *
 * → **但不能把原始 args 直接给 agent** ✓：
 * `exec_regex` 的 args 里有 **`command`** ✓（一条要跑在板子上的裸命令 ✓），
 * `script` 的 args 里有 **`path`（宿主文件系统上的路径）**与 **`interpreter`** ✓
 * → 那两个拼起来就是「宿主上有什么、在哪」+「一条命令」✗
 * → **正是契约 §1.3「不准有裸 send_command」要防的那件事** ✓。
 *
 * ── 放行表按 `(kind, 参数名)` 判定 ──
 *
 * **不是**按参数名单独判定 ✓ —— 因为 `path` 在 `file_read` 里是**板上路径**（可给 ✓），
 * 在 `script` 里是**宿主路径**（不可给 ✓）。
 *
 * → 这张表**逐 kind 写死** ✓（契约 v5 §2.4 的那张 ✓）✓
 * → **不在表里的参数一律不给** ✓（封闭表，不是「先给再筛」✓）。
 */

const PACK: BoardPack = {
  apiVersion: 'devboard/v1',
  kind: 'BoardPack',
  id: 'demo-pack',
  name: '演示板型包',
  version: '1.0.0',
  requires: { transports: ['adb'], capabilities: ['shell', 'exec'] },
  poll_groups: [
    { id: 'fast', interval_ms: 1000, readers: ['cpu', 'uptime'] },
    { id: 'slow', interval_ms: 30000, readers: ['temp'] },
  ],
  readers: [
    {
      id: 'cpu',
      kind: 'proc_stat',
      args: { stat_path: '/proc/stat', cpuinfo_path: '/proc/cpuinfo' },
      provides: [{ tag: 'cpu.usage', sample: 'usage' }],
    },
    {
      id: 'uptime',
      kind: 'exec_regex',
      args: { command: 'cat /proc/uptime', pattern: '^([0-9.]+)', format: 'float' },
      provides: [{ tag: 'custom.demo-pack.uptime_s', sample: 'value' }],
    },
    {
      id: 'temp',
      kind: 'thermal_zone',
      args: { glob: '/sys/class/thermal/*', type_map: { 'soc-thermal': 'soc' } },
      provides: [{ tag: 'temp.soc', sample: 'zone.soc' }],
    },
    {
      id: 'mem',
      kind: 'meminfo',
      args: { path: '/proc/meminfo' },
      provides: [{ tag: 'mem.usage', sample: 'usage' }],
    },
    {
      id: 'load',
      kind: 'file_read',
      args: { path: '/proc/loadavg', format: 'string' },
      provides: [{ tag: 'custom.demo-pack.load', sample: 'value' }],
    },
    {
      id: 'df',
      kind: 'devfreq_load',
      args: { path: '/sys/class/devfreq/fdab0000.npu/load', measure: 'utilization' },
      provides: [{ tag: 'npu.usage', sample: 'utilization' }],
    },
    {
      id: 'npu',
      kind: 'rknpu_load',
      args: { path: '/sys/kernel/debug/rknpu/load' },
      provides: [{ tag: 'custom.demo-pack.npu_load', sample: 'value' }],
    },
    {
      id: 'scripted',
      kind: 'script',
      args: { path: 'scripts/status.sh', interpreter: '/bin/sh', format: 'json' },
      provides: [{ tag: 'custom.demo-pack.scripted', sample: 'value' }],
    },
  ],
  custom: [],
  actions: [],
};

describe('板型包的脱敏投影', () => {
  it('**包的身份与轮询组都在** ✓（agent 要知道「这是什么板」）', () => {
    const view = packView(PACK)!;
    expect(view.id).toBe('demo-pack');
    expect(view.name).toBe('演示板型包');
    expect(view.version).toBe('1.0.0');
    expect(view.poll_groups.map((g) => g.id)).toEqual(['fast', 'slow']);
    expect(view.poll_groups[0]?.interval_ms).toBe(1000);
    expect(view.poll_groups[1]?.interval_ms).toBe(30000);
  });

  it('**reader 的 provides 是具体 tag 模式** ✓（agent 要知道它提供什么）', () => {
    const view = packView(PACK)!;
    const cpu = view.readers.find((r) => r.id === 'cpu');
    expect(cpu?.provides).toEqual(['cpu.usage']);
    expect(cpu?.kind).toBe('proc_stat');
  });

  it('**`exec_regex` 的 `command` 一个字都不给** ✓（裸命令不能漏给 agent）', () => {
    const view = packView(PACK)!;
    const uptime = view.readers.find((r) => r.id === 'uptime');
    expect(uptime).toBeTruthy();
    const dumped = JSON.stringify(uptime);
    expect(dumped).not.toContain('cat /proc/uptime');
    expect(dumped).not.toContain('command');
    // **但正则与格式要给** ✓（那不是命令 ✓）
    expect(uptime?.args['pattern']).toBe('^([0-9.]+)');
    expect(uptime?.args['format']).toBe('float');
  });

  it('**`script` 的宿主路径与解释器都不给** ✓（泄漏本机目录结构）', () => {
    const view = packView(PACK)!;
    const scripted = view.readers.find((r) => r.id === 'scripted');
    expect(scripted).toBeTruthy();
    const dumped = JSON.stringify(scripted);
    expect(dumped).not.toContain('scripts/status.sh');
    expect(dumped).not.toContain('/bin/sh');
    // **`script` 的 args 恒为空** ✓
    expect(scripted?.args).toEqual({});
  });

  it('**板上的路径要给** ✓（契约说「哪个文件」✓ —— `file_read` / `meminfo` / `proc_stat`）', () => {
    const view = packView(PACK)!;
    expect(view.readers.find((r) => r.id === 'load')?.args['path']).toBe('/proc/loadavg');
    expect(view.readers.find((r) => r.id === 'mem')?.args['path']).toBe('/proc/meminfo');
    expect(view.readers.find((r) => r.id === 'cpu')?.args['stat_path']).toBe('/proc/stat');
    expect(view.readers.find((r) => r.id === 'cpu')?.args['cpuinfo_path']).toBe('/proc/cpuinfo');
  });

  it('**`thermal_zone` 的 `type_map` 要给** ✓（那是归并表 —— agent 要知道 temp.soc 是怎么归并的）', () => {
    const view = packView(PACK)!;
    const temp = view.readers.find((r) => r.id === 'temp');
    expect(temp?.args['type_map']).toEqual({ 'soc-thermal': 'soc' });
    expect(temp?.args['glob']).toBe('/sys/class/thermal/*');
  });

  it('**`devfreq_load` 的 `measure` 要给** ✓（那是单位语义的一部分）', () => {
    const view = packView(PACK)!;
    expect(view.readers.find((r) => r.id === 'df')?.args['measure']).toBe('utilization');
  });

  it('**`custom` 里的 reader 也要在** ✓（否则 custom.* 的量全都是 null）', () => {
    const withCustom: BoardPack = {
      ...PACK,
      custom: [
        {
          id: 'priv',
          kind: 'file_read',
          args: { path: '/run/priv' },
          provides: [{ tag: 'custom.demo-pack.priv', sample: 'value' }],
        },
      ],
    };
    const view = packView(withCustom)!;
    expect(view.readers.map((r) => r.id)).toContain('priv');
  });

  it('**没有包就是 `null`** ✓（不猜 ✓）', () => {
    expect(packView(undefined)).toBeNull();
  });

  it('**放行表是封闭的** ✓ —— 表里没有的参数一律不给 ✓', () => {
    const withUnknown: BoardPack = {
      ...PACK,
      readers: [
        {
          id: 'weird',
          kind: 'file_read',
          // **参数名不在放行表里** ✓
          args: { path: '/a', secret: 'x' } as never,
          provides: [{ tag: 'custom.demo-pack.weird', sample: 'value' }],
        },
      ],
    };
    const view = packView(withUnknown)!;
    const weird = view.readers.find((r) => r.id === 'weird');
    expect(weird?.args['path']).toBe('/a');
    expect(weird?.args['secret']).toBeUndefined();
  });
});

/** 类型导出检查（编译期 ✓） */
export type { PackView as _PackView };
const _typeCheck: PackView | null = null;
void _typeCheck;

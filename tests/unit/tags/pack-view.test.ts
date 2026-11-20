import { describe, it, expect } from 'vitest';
import { packView, type PackView } from '../../../src/main/tags/pack-view';
import type { BoardPack } from '../../../src/main/tags/schema';

/**
 * The **redacted read-only projection of a board pack** (contract `spec/04`
 * §2.1 / §2.4).
 *
 * Why this layer exists:
 *
 * `TagRuntime.pack` is **private**, and the read-side tools of MCP have to
 * see it (`list_data_sources` / `describe_tag` / `list_tags`).
 *
 * → **But the raw args may not be handed to an agent**: the args of
 *   `exec_regex` hold a **`command`** (a bare command that has to run on
 *   the board) and the args of `script` hold a **`path` (a path on the file
 *   system of the host)** and the **`interpreter`** — together that is "what
 *   the host has and where" plus "a command", which is exactly what the
 *   contract §1.3, "no bare send_command", is there to prevent.
 *
 * The table of what is let through is decided by `(kind, name of the
 * parameter)`:
 *
 * **Not** by the name of the parameter alone — `path` is a **path on the
 * board** in `file_read` (it may be given) and a **path on the host** in
 * `script` (it may not).
 *
 * → The table is **written out for every kind** and **a parameter that is not
 *   in the table is never given** (a closed table, not "give it and filter
 *   afterwards").
 */

const PACK: BoardPack = {
  apiVersion: 'devboard/v1',
  kind: 'BoardPack',
  id: 'demo-pack',
  name: 'demo board pack',
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

describe('the redacted projection of a board pack', () => {
  it('**the identity of the pack and its poll groups are there** (the agent has to know "what kind of board is this")', () => {
    const view = packView(PACK)!;
    expect(view.id).toBe('demo-pack');
    expect(view.name).toBe('demo board pack');
    expect(view.version).toBe('1.0.0');
    expect(view.poll_groups.map((g) => g.id)).toEqual(['fast', 'slow']);
    expect(view.poll_groups[0]?.interval_ms).toBe(1000);
    expect(view.poll_groups[1]?.interval_ms).toBe(30000);
  });

  it('**the provides of a reader are the concrete tag patterns** (the agent has to know what it offers)', () => {
    const view = packView(PACK)!;
    const cpu = view.readers.find((r) => r.id === 'cpu');
    expect(cpu?.provides).toEqual(['cpu.usage']);
    expect(cpu?.kind).toBe('proc_stat');
  });

  it('**not one character of the `command` of `exec_regex` is given** (a bare command may not leak to the agent)', () => {
    const view = packView(PACK)!;
    const uptime = view.readers.find((r) => r.id === 'uptime');
    expect(uptime).toBeTruthy();
    const dumped = JSON.stringify(uptime);
    expect(dumped).not.toContain('cat /proc/uptime');
    expect(dumped).not.toContain('command');
    // **But the pattern and the format are given** (those are not a command)
    expect(uptime?.args['pattern']).toBe('^([0-9.]+)');
    expect(uptime?.args['format']).toBe('float');
  });

  it('**neither the host path nor the interpreter of `script` is given** (it would leak the directory structure of the host)', () => {
    const view = packView(PACK)!;
    const scripted = view.readers.find((r) => r.id === 'scripted');
    expect(scripted).toBeTruthy();
    const dumped = JSON.stringify(scripted);
    expect(dumped).not.toContain('scripts/status.sh');
    expect(dumped).not.toContain('/bin/sh');
    // **The args of `script` are always empty**
    expect(scripted?.args).toEqual({});
  });

  it('**the paths on the board are given** (the contract says "which file" — `file_read` / `meminfo` / `proc_stat`)', () => {
    const view = packView(PACK)!;
    expect(view.readers.find((r) => r.id === 'load')?.args['path']).toBe('/proc/loadavg');
    expect(view.readers.find((r) => r.id === 'mem')?.args['path']).toBe('/proc/meminfo');
    expect(view.readers.find((r) => r.id === 'cpu')?.args['stat_path']).toBe('/proc/stat');
    expect(view.readers.find((r) => r.id === 'cpu')?.args['cpuinfo_path']).toBe('/proc/cpuinfo');
  });

  it('**the `type_map` of `thermal_zone` is given** (it is the merging table — the agent has to know how temp.soc is merged)', () => {
    const view = packView(PACK)!;
    const temp = view.readers.find((r) => r.id === 'temp');
    expect(temp?.args['type_map']).toEqual({ 'soc-thermal': 'soc' });
    expect(temp?.args['glob']).toBe('/sys/class/thermal/*');
  });

  it('**the `measure` of `devfreq_load` is given** (it is part of the meaning of the unit)', () => {
    const view = packView(PACK)!;
    expect(view.readers.find((r) => r.id === 'df')?.args['measure']).toBe('utilization');
  });

  it('**the readers of `custom` are there as well** (otherwise every quantity of `custom.*` would be null)', () => {
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

  it('**no pack is `null`** (it does not guess)', () => {
    expect(packView(undefined)).toBeNull();
  });

  it('**the table of what is let through is closed** — a parameter that is not in the table is never given', () => {
    const withUnknown: BoardPack = {
      ...PACK,
      readers: [
        {
          id: 'weird',
          kind: 'file_read',
          // **The name of the parameter is not in the table of what is let through**
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

/** The check of the exported types (at compile time) */
export type { PackView as _PackView };
const _typeCheck: PackView | null = null;
void _typeCheck;

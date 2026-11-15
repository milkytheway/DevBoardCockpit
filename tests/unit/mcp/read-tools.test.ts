import { describe, it, expect } from 'vitest';
import {
  listConnections,
  listDataSources,
  listCapabilities,
  listTags,
  describeTag,
  sampleTag,
  listCards,
  getCardRuntimeLog,
  getLayout,
  normalizeLayoutCards,
  withVersion,
  withVersionEach,
} from '../../../src/main/mcp/read-tools';
import type { McpHostDeps, McpCardEntry } from '../../../src/main/mcp/host';
import type { TagReading } from '../../../src/shared/tag-reading';
import type { PackView } from '../../../src/main/tags/pack-view';
import type { CardManifest } from '../../../src/main/cards/manifest';
import type { CardLogEntry } from '../../../src/main/cards/runtime-log';

/**
 * **读侧工具的投影**（契约 `spec/04` §2.1 / §2.2 / §2.3 / §2.5 ✓ · ADR-D40 ✓）。
 *
 * ── 这组判据守什么 ──
 *
 * | 判据 | 为什么 |
 * |---|---|
 * | **字段名照契约**（`name` 不是 `tag` ✓ · `card_id` 不是 `cardId` ✓） | agent 按名字取字段 ✓ |
 * | **`apiVersion` 每一项都带** ✓ | 契约 §四 ✓ |
 * | **`source_reader` 算 `custom` 的 reader** ✓ | 否则 `custom.*` 全是 `null` ✓ |
 * | **reader 的 status 是映射表** ✓ | 契约 §2.1 ✓ |
 * | **命令不漏** ✓ | `args_summary` ✓ |
 */

const PACK: PackView = {
  id: 'demo-pack',
  name: '演示包',
  version: '1.0.0',
  poll_groups: [{ id: 'fast', interval_ms: 1000, readers: ['cpu'] }],
  readers: [
    {
      id: 'cpu',
      kind: 'proc_stat',
      args: { stat_path: '/proc/stat' },
      provides: ['cpu.usage', 'cpu.core.*.usage'],
      poll_group: 'fast',
      interval_ms: 1000,
    },
    {
      id: 'priv',
      kind: 'file_read',
      args: { path: '/run/priv' },
      provides: ['custom.demo-pack.priv'],
      poll_group: 'fast',
      interval_ms: 1000,
    },
  ],
  actions: [],
};

function reading(tag: string, status: TagReading['status'] = 'ok', value: number | null = 1): TagReading {
  return { tag, value, unit: '%', status, at: 1000, seq: 1 };
}

function deps(over: Partial<McpHostDeps> = {}): McpHostDeps {
  const base: McpHostDeps = {
    pack: () => PACK,
    readings: () => [reading('cpu.usage'), reading('cpu.core.0.usage')],
    history: () => [],
    refreshTag: async () => undefined,
    profiles: () => [
      { id: 'guest', label: '客机', transport: 'ssh', options: {} },
      { id: 'board', label: '板子', transport: 'adb', board_pack: 'demo-pack', options: {} },
    ],
    capabilities: () => ({ exec: true, pty: false, files: true, exitCode: true }),
    connected: () => false,
    cards: () => [],
    cardDir: () => null,
    cardLog: () => [],
    validateCard: () => ({
      ok: true,
      errors: [],
      warnings: [],
      resolved: { tags: [], actions: [], layout: null, missing_tags: [], missing_actions: [] },
    }),
    layout: () => ({ version: 3, units: [], density: 'comfortable', updatedAt: 0 }),
    saveLayout: () => undefined,
  };
  return { ...base, ...over };
}

const MANIFEST: CardManifest = {
  apiVersion: 'devboard/v1',
  kind: 'Card',
  id: 'demo',
  name: '演示卡',
  version: '1.0.0',
  entry: 'index.html',
  permissions: { read: ['cpu.usage'], write: [] },
};

describe('MCP · 读侧 · list_connections', () => {
  it('**字段是契约的那些** ✓（`board_pack` 给 id ✓ —— **不给版本** ✓）', () => {
    const list = listConnections(deps());
    expect(list[0]).toEqual({
      id: 'guest',
      label: '客机',
      transport: 'ssh',
      board_pack: null,
      connected: false,
      capabilities: { exec: true, pty: false, files: true, exitCode: true },
    });
    expect(list[1]?.['board_pack']).toBe('demo-pack');
  });

  it('**`connected` 问的是「这条 profile 现在有活连接吗」✓', () => {
    const list = listConnections(deps({ connected: (id) => id === 'guest' }));
    expect(list[0]?.['connected']).toBe(true);
    expect(list[1]?.['connected']).toBe(false);
  });
});

describe('MCP · 读侧 · list_data_sources', () => {
  it('**`id` 是 reader id** ✓（数据源就是 reader 粒度 ✓）', () => {
    const list = listDataSources(deps());
    expect(list.map((r) => r['id'])).toEqual(['cpu', 'priv']);
    expect(list[0]?.['board']).toBe('demo-pack');
    expect(list[0]?.['poll_group']).toBe('fast');
    expect(list[0]?.['interval_ms']).toBe(1000);
  });

  it('**`provides` 展开成具体名** ✓（包里写的是模式 ✓）', () => {
    const list = listDataSources(deps());
    expect(list[0]?.['provides']).toEqual(['cpu.core.0.usage', 'cpu.usage']);
  });

  it('**reader 的 status 是映射表** ✓', () => {
    // **全部 ok → ok** ✓
    expect(listDataSources(deps())[0]?.['status']).toBe('ok');
    // **有 error → error** ✓
    expect(
      listDataSources(deps({ readings: () => [reading('cpu.usage', 'error', null)] }))[0]?.['status'],
    ).toBe('error');
    // **一个都没读出来 → pending** ✓
    expect(listDataSources(deps({ readings: () => [] }))[0]?.['status']).toBe('pending');
    // **全部 unavailable → unavailable** ✓
    expect(
      listDataSources(deps({ readings: () => [reading('cpu.usage', 'unavailable', null)] }))[0]?.[
        'status'
      ],
    ).toBe('unavailable');
  });

  it('**没有包 → 空数组** ✓', () => {
    expect(listDataSources(deps({ pack: () => null }))).toEqual([]);
  });
});

describe('MCP · 读侧 · list_capabilities', () => {
  it('**`transports` 是当前有的传输** ✓ · `features` 是封闭词表** ✓', () => {
    const caps = listCapabilities(deps());
    expect(caps['transports']).toEqual(['adb', 'ssh']);
    expect(caps['features']).toEqual(['cards', 'mcp', 'layout_share', 'record']);
  });
});

describe('MCP · 读侧 · list_tags', () => {
  it('**`name` 不是 `tag`** ✓（契约的字段名 ✓）', () => {
    const list = listTags(deps());
    expect(list[0]?.['name']).toBe('cpu.usage');
    expect(list[0]?.['tag']).toBeUndefined();
  });

  it('**`type` / `unit` / `range` 来自核心词表** ✓', () => {
    const list = listTags(deps());
    expect(list[0]?.['type']).toBe('number');
    // **词表里的单位是 `percent`** ✓（**不是**读数上的那个 `%` ✓ —— 那是采样器给的 ✓）
    expect(list[0]?.['unit']).toBe('percent');
    expect(list[0]?.['range']).toEqual([0, 100]);
  });

  it('**`source_reader` 算得出来** ✓', () => {
    const list = listTags(deps());
    expect(list[0]?.['source_reader']).toBe('cpu');
  });

  it('**`custom.*` 的量 `source_reader` 也要算得出** ✓（不算就全是 null ✓）', () => {
    const list = listTags(
      deps({ readings: () => [reading('custom.demo-pack.priv')] }),
    );
    expect(list[0]?.['source_reader']).toBe('priv');
  });

  it('**`board` 是当前包 id** ✓', () => {
    expect(listTags(deps())[0]?.['board']).toBe('demo-pack');
  });
});

describe('MCP · 读侧 · describe_tag', () => {
  it('**`semantics` 是词表原文** ✓ · `history` 是样本** ✓', () => {
    const d = describeTag(deps(), 'cpu.usage');
    expect(d?.['semantics']).toBeTruthy();
    expect(Array.isArray(d?.['history'])).toBe(true);
  });

  it('**`source.args_summary` 不含命令** ✓（脱敏 ✓）', () => {
    const pack: PackView = {
      ...PACK,
      readers: [
        {
          id: 'up',
          kind: 'exec_regex',
          args: { pattern: '^([0-9.]+)' },
          provides: ['custom.demo-pack.up'],
          poll_group: 'fast',
          interval_ms: 1000,
        },
      ],
    };
    const d = describeTag(deps({ pack: () => pack }), 'custom.demo-pack.up');
    const dumped = JSON.stringify(d);
    expect(dumped).not.toContain('cat /proc/uptime');
    expect(dumped).not.toContain('command');
  });

  it('**没有词表条目的 `custom.*` → `semantics` 是 `null`** ✓', () => {
    const d = describeTag(deps(), 'custom.demo-pack.priv');
    expect(d?.['semantics']).toBeNull();
    expect(d?.['type']).toBeNull();
  });
});

describe('MCP · 读侧 · sample_tag', () => {
  it('**给的就是宿主缓冲里的样本** ✓', () => {
    const samples = [{ value: 1, unit: '%', status: 'ok' as const, at: 5 }];
    expect(sampleTag(deps({ history: () => samples }), 'cpu.usage', 10)).toEqual(samples);
  });
});

describe('MCP · 读侧 · list_cards', () => {
  const card: McpCardEntry = {
    cardId: 'demo-dir',
    dir: '/cards/demo-dir',
    manifest: MANIFEST,
    issues: [],
    state: {
      installed_at: 1234,
      status: 'degraded',
      degraded: true,
      missing_tags: ['npu.usage'],
      unreadable_tags: ['cpu.usage'],
    },
  };

  it('**`id` 是目录名、`manifest_id` 是 manifest 声明的** ✓（两者可不同 ✓）', () => {
    const list = listCards(deps({ cards: () => [card] }));
    expect(list[0]?.['id']).toBe('demo-dir');
    expect(list[0]?.['manifest_id']).toBe('demo');
  });

  it('**`missing_tags` 与 `unreadable_tags` 都在** ✓', () => {
    const list = listCards(deps({ cards: () => [card] }));
    expect(list[0]?.['missing_tags']).toEqual(['npu.usage']);
    expect(list[0]?.['unreadable_tags']).toEqual(['cpu.usage']);
    expect(list[0]?.['degraded']).toBe(true);
    expect(list[0]?.['status']).toBe('degraded');
  });

  it('**`path` 是绝对路径** ✓ · `installed_at` 是目录 mtime** ✓', () => {
    const list = listCards(deps({ cards: () => [card] }));
    expect(list[0]?.['path']).toBe('/cards/demo-dir');
    expect(list[0]?.['installed_at']).toBe(1234);
  });
});

describe('MCP · 读侧 · get_card_runtime_log', () => {
  const entries: CardLogEntry[] = [
    { at: 100, source: 'card', level: 'info', message: 'a' },
    { at: 200, source: 'csp', level: 'error', message: 'b' },
  ];

  it('**`since` 过滤真的过滤** ✓', () => {
    const list = getCardRuntimeLog(deps({ cardLog: () => entries }), 'demo', 150);
    expect(list).toHaveLength(1);
    expect(list[0]?.['message']).toBe('b');
  });

  it('**缺省给全部** ✓', () => {
    expect(getCardRuntimeLog(deps({ cardLog: () => entries }), 'demo', undefined)).toHaveLength(2);
  });

  it('**字段是 `level` / `at` / `message` / `source`** ✓', () => {
    const list = getCardRuntimeLog(deps({ cardLog: () => entries }), 'demo', undefined);
    expect(Object.keys(list[0] as object).sort()).toEqual(['at', 'level', 'message', 'source']);
  });
});

describe('MCP · 读侧 · 布局', () => {
  it('**`card_id` 不是 `cardId`** ✓ · `connection_id` 要带上** ✓', () => {
    const layout = deps({
      layout: () => ({
        version: 3,
        units: [{ cardId: 'demo', connectionId: 'board', x: 0, y: 0, w: 3, h: 2 }],
        density: 'comfortable',
        updatedAt: 0,
      }),
    });
    const out = getLayout(layout);
    expect(out['cards']).toEqual([
      { card_id: 'demo', connection_id: 'board', x: 0, y: 0, w: 3, h: 2 },
    ]);
  });

  it('**越界的格子整条丢掉并报进 `dropped`** ✓', () => {
    const out = normalizeLayoutCards([
      { card_id: 'ok', x: 0, y: 0, w: 3, h: 2 },
      { card_id: 'wide', x: 0, y: 0, w: 99, h: 2 },
      { card_id: 'neg', x: -1, y: 0, w: 3, h: 2 },
      { card_id: 'zero', x: 0, y: 0, w: 0, h: 2 },
    ]);
    expect(out.cards.map((c) => c.card_id)).toEqual(['ok']);
    expect(out.dropped.sort()).toEqual(['neg', 'wide', 'zero']);
  });

  it('**重叠不判** ✓（交给渲染器 ✓）', () => {
    const out = normalizeLayoutCards([
      { card_id: 'a', x: 0, y: 0, w: 3, h: 2 },
      { card_id: 'b', x: 0, y: 0, w: 3, h: 2 },
    ]);
    expect(out.cards).toHaveLength(2);
    expect(out.dropped).toEqual([]);
  });
});

describe('MCP · apiVersion', () => {
  it('**每个响应都带** ✓', () => {
    expect(withVersion({ ok: true })['apiVersion']).toBe('devboard/v1');
  });

  it('**列表是每一项都带** ✓', () => {
    const list = withVersionEach([{ a: 1 }, { a: 2 }]);
    expect(list.every((i) => i['apiVersion'] === 'devboard/v1')).toBe(true);
  });
});

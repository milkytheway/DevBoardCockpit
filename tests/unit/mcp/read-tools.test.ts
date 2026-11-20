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
 * The projections of the read-side tools (contract `spec/04` §2.1 / §2.2 / §2.3
 * / §2.5).
 *
 * What these criteria guard:
 *
 * | Criterion | Why |
 * |---|---|
 * | **the field names follow the contract** (`name` is not `tag`, `card_id` is not `cardId`) | an agent takes the fields by name |
 * | **`apiVersion` is on every item** | contract §4 |
 * | **`source_reader` also resolves a `custom` reader** | otherwise every `custom.*` is `null` |
 * | **the status of a reader is a mapping table** | contract §2.1 |
 * | **the command is not dropped** | `args_summary` |
 */

const PACK: PackView = {
  id: 'demo-pack',
  name: 'demo pack',
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
      { id: 'guest', label: 'the guest', transport: 'ssh', options: {} },
      { id: 'board', label: 'the board', transport: 'adb', board_pack: 'demo-pack', options: {} },
    ],
    capabilities: () => ({ exec: true, pty: false, files: true, exitCode: true }),
    connected: () => false,
    // **the connection of the current runtime** (**null when there is none**)
    currentProfileId: () => 'board',
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
    actions: {} as never,
  };
  return { ...base, ...over };
}

const MANIFEST: CardManifest = {
  apiVersion: 'devboard/v1',
  kind: 'Card',
  id: 'demo',
  name: 'demo card',
  version: '1.0.0',
  entry: 'index.html',
  permissions: { read: ['cpu.usage'], write: [] },
};

describe('MCP · read side · list_connections', () => {
  it('**the fields are the ones of the contract** (`board_pack` gives the id, **not the version**)', () => {
    const list = listConnections(deps());
    expect(list[0]).toEqual({
      id: 'guest',
      label: 'the guest',
      transport: 'ssh',
      board_pack: null,
      // **a device (the board) and a connection are two layers** — contract `spec/02` §10.2
      device_key: 'guest',
      // **the one of the current runtime** (contract `spec/04` §2.1)
      current: false,
      connected: false,
      capabilities: { exec: true, pty: false, files: true, exitCode: true },
    });
    expect(list[1]?.['board_pack']).toBe('demo-pack');
  });

  it('**`connected` asks whether this profile has a live connection right now**', () => {
    const list = listConnections(deps({ connected: (id) => id === 'guest' }));
    expect(list[0]?.['connected']).toBe(true);
    expect(list[1]?.['connected']).toBe(false);
  });
});

describe('MCP · read side · list_data_sources', () => {
  it('**`id` is the reader id** (a data source has the granularity of a reader)', () => {
    const list = listDataSources(deps());
    expect(list.map((r) => r['id'])).toEqual(['cpu', 'priv']);
    expect(list[0]?.['board']).toBe('demo-pack');
    expect(list[0]?.['poll_group']).toBe('fast');
    expect(list[0]?.['interval_ms']).toBe(1000);
  });

  it('**`provides` is expanded into concrete names** (the pack states a pattern)', () => {
    const list = listDataSources(deps());
    expect(list[0]?.['provides']).toEqual(['cpu.core.0.usage', 'cpu.usage']);
  });

  it('**the status of a reader is a mapping table**', () => {
    // **all ok → ok**
    expect(listDataSources(deps())[0]?.['status']).toBe('ok');
    // **one error → error**
    expect(
      listDataSources(deps({ readings: () => [reading('cpu.usage', 'error', null)] }))[0]?.['status'],
    ).toBe('error');
    // **none of them was read → pending**
    expect(listDataSources(deps({ readings: () => [] }))[0]?.['status']).toBe('pending');
    // **all unavailable → unavailable**
    expect(
      listDataSources(deps({ readings: () => [reading('cpu.usage', 'unavailable', null)] }))[0]?.[
        'status'
      ],
    ).toBe('unavailable');
  });

  it('**no pack → an empty array**', () => {
    expect(listDataSources(deps({ pack: () => null }))).toEqual([]);
  });
});

describe('MCP · read side · list_capabilities', () => {
  it('**`transports` are the transports available now** · `features` is a closed vocabulary', () => {
    const caps = listCapabilities(deps());
    expect(caps['transports']).toEqual(['adb', 'ssh']);
    expect(caps['features']).toEqual(['cards', 'mcp', 'layout_share', 'record']);
  });
});

describe('MCP · read side · list_tags', () => {
  it('**the field is `name`, not `tag`** (the field names of the contract)', () => {
    const list = listTags(deps());
    expect(list[0]?.['name']).toBe('cpu.usage');
    expect(list[0]?.['tag']).toBeUndefined();
  });

  it('**`type` / `unit` / `range` come from the core vocabulary**', () => {
    const list = listTags(deps());
    expect(list[0]?.['type']).toBe('number');
    // **the unit in the vocabulary is `percent`** (**not** the `%` of a reading —
// that one comes from the sampler)
    expect(list[0]?.['unit']).toBe('percent');
    expect(list[0]?.['range']).toEqual([0, 100]);
  });

  it('**`source_reader` can be computed**', () => {
    const list = listTags(deps());
    expect(list[0]?.['source_reader']).toBe('cpu');
  });

  it('**the `source_reader` of a `custom.*` quantity can be computed as well** (otherwise they are all null)', () => {
    const list = listTags(
      deps({ readings: () => [reading('custom.demo-pack.priv')] }),
    );
    expect(list[0]?.['source_reader']).toBe('priv');
  });

  it('**`board` is the id of the current pack**', () => {
    expect(listTags(deps())[0]?.['board']).toBe('demo-pack');
  });
});

describe('MCP · read side · describe_tag', () => {
  it('**`semantics` is the vocabulary entry verbatim** · `history` is the samples', () => {
    const d = describeTag(deps(), 'cpu.usage');
    expect(d?.['semantics']).toBeTruthy();
    expect(Array.isArray(d?.['history'])).toBe(true);
  });

  it('**`source.args_summary` does not contain the command** (it is redacted)', () => {
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

  it('**a `custom.*` without a vocabulary entry → `semantics` is `null`**', () => {
    const d = describeTag(deps(), 'custom.demo-pack.priv');
    expect(d?.['semantics']).toBeNull();
    expect(d?.['type']).toBeNull();
  });
});

describe('MCP · read side · sample_tag', () => {
  it('**what it returns is the sample in the host buffer**', () => {
    const samples = [{ value: 1, unit: '%', status: 'ok' as const, at: 5 }];
    expect(sampleTag(deps({ history: () => samples }), 'cpu.usage', 10)).toEqual(samples);
  });
});

describe('MCP · read side · list_cards', () => {
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

  it('**`id` is the directory name, `manifest_id` is the one the manifest declares** (the two may differ)', () => {
    const list = listCards(deps({ cards: () => [card] }));
    expect(list[0]?.['id']).toBe('demo-dir');
    expect(list[0]?.['manifest_id']).toBe('demo');
  });

  it('**both `missing_tags` and `unreadable_tags` are present**', () => {
    const list = listCards(deps({ cards: () => [card] }));
    expect(list[0]?.['missing_tags']).toEqual(['npu.usage']);
    expect(list[0]?.['unreadable_tags']).toEqual(['cpu.usage']);
    expect(list[0]?.['degraded']).toBe(true);
    expect(list[0]?.['status']).toBe('degraded');
  });

  it('**`path` is an absolute path** · `installed_at` is the mtime of the directory', () => {
    const list = listCards(deps({ cards: () => [card] }));
    expect(list[0]?.['path']).toBe('/cards/demo-dir');
    expect(list[0]?.['installed_at']).toBe(1234);
  });
});

describe('MCP · read side · get_card_runtime_log', () => {
  const entries: CardLogEntry[] = [
    { at: 100, source: 'card', level: 'info', message: 'a' },
    { at: 200, source: 'csp', level: 'error', message: 'b' },
  ];

  it('**the `since` filter really filters**', () => {
    const list = getCardRuntimeLog(deps({ cardLog: () => entries }), 'demo', 150);
    expect(list).toHaveLength(1);
    expect(list[0]?.['message']).toBe('b');
  });

  it('**the default gives everything**', () => {
    expect(getCardRuntimeLog(deps({ cardLog: () => entries }), 'demo', undefined)).toHaveLength(2);
  });

  it('**the fields are `level` / `at` / `message` / `source`**', () => {
    const list = getCardRuntimeLog(deps({ cardLog: () => entries }), 'demo', undefined);
    expect(Object.keys(list[0] as object).sort()).toEqual(['at', 'level', 'message', 'source']);
  });
});

describe('MCP · read side · layout', () => {
  it('**the field is `card_id`, not `cardId`** · `connection_id` must be carried', () => {
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

  it('**a cell out of bounds is dropped as a whole and reported in `dropped`**', () => {
    const out = normalizeLayoutCards([
      { card_id: 'ok', x: 0, y: 0, w: 3, h: 2 },
      { card_id: 'wide', x: 0, y: 0, w: 99, h: 2 },
      { card_id: 'neg', x: -1, y: 0, w: 3, h: 2 },
      { card_id: 'zero', x: 0, y: 0, w: 0, h: 2 },
    ]);
    expect(out.cards.map((c) => c.card_id)).toEqual(['ok']);
    expect(out.dropped.sort()).toEqual(['neg', 'wide', 'zero']);
  });

  it('**overlap is not judged** (that is left to the renderer)', () => {
    const out = normalizeLayoutCards([
      { card_id: 'a', x: 0, y: 0, w: 3, h: 2 },
      { card_id: 'b', x: 0, y: 0, w: 3, h: 2 },
    ]);
    expect(out.cards).toHaveLength(2);
    expect(out.dropped).toEqual([]);
  });
});

describe('MCP · apiVersion', () => {
  it('**every response carries it**', () => {
    expect(withVersion({ ok: true })['apiVersion']).toBe('devboard/v1');
  });

  it('**a list carries it on every item**', () => {
    const list = withVersionEach([{ a: 1 }, { a: 2 }]);
    expect(list.every((i) => i['apiVersion'] === 'devboard/v1')).toBe(true);
  });
});

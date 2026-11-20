import { describe, it, expect, beforeEach } from 'vitest';
import { listConnections } from '../../../src/main/mcp/read-tools';
import { executeAction } from '../../../src/main/mcp/action-tools';
import type { McpHostDeps } from '../../../src/main/mcp/host';
import type { AgentActionDeps } from '../../../src/main/mcp/action-tools';
import type { ActionDef } from '../../../src/main/tags/schema';
import type { TagReading } from '../../../src/shared/tag-reading';

/**
 * A device (the board itself) and a connection are two layers (contract
 * `spec/02` §10.2–10.3, `spec/04` §2.1/§2.4).
 *
 * What these criteria guard:
 *
 * | Criterion | Why |
 * |---|---|
 * | **`list_connections` carries a `device_key`** | only then does the agent know **which connections are the same board** |
 * | **`list_connections` carries `current`** | otherwise it **does not know which board is the current one**, and `device_key` has no legal value to fill in |
 * | **`execute_action` with another device → `not_found`** | **it never silently targets the current board** (that would be doing something else without saying so) |
 *
 * The credential layer is gone. The device check remains: it is not a matter of
 * asking the operator, it is a matter of hitting the right thing.
 */
const BACKLIGHT: ActionDef = {
  id: 'backlight.set',
  label: 'set the backlight brightness',
  danger: 'reversible',
  params: { value: { type: 'integer', min: 16, max: 255 } },
  guard: { value: { min: 16, max: 255 } },
  command: 'echo {value} > /sys/class/backlight/backlight/brightness',
  readback: { kind: 'tag', tag: 'custom.demo.brightness' },
};

const REBOOT: ActionDef = {
  id: 'system.reboot',
  label: 'reboot the board',
  danger: 'destructive',
  command: 'reboot',
  readback: { kind: 'verify', command: 'true' },
};

/** The two connections of one board plus a guest machine */
const PROFILES = [
  {
    id: 'board-adb',
    label: 'board · ADB',
    transport: 'adb' as const,
    board_pack: 'demo-pack',
    device_key: 'atk-01',
    options: {},
  },
  {
    id: 'board-ssh',
    label: 'board · SSH',
    transport: 'ssh' as const,
    board_pack: 'demo-pack',
    device_key: 'atk-01',
    options: { host: '192.168.5.100' },
  },
  { id: 'guest', label: 'the guest', transport: 'ssh' as const, options: {} },
];

function hostDeps(over: Partial<McpHostDeps> = {}): McpHostDeps {
  return {
    pack: () => null,
    readings: () => [],
    history: () => [],
    refreshTag: async () => undefined,
    profiles: () => PROFILES,
    capabilities: () => ({ exec: true, pty: false, files: true, exitCode: true }),
    connected: () => false,
    currentProfileId: () => 'board-ssh',
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
    ...over,
  };
}

let executed: string[];
let audits: number;
/** **the `device_key` of the connection of the current runtime** (it changes — when the board is swapped) */
let currentDevice: string;
let deps: AgentActionDeps;

beforeEach(() => {
  executed = [];
  audits = 0;
  currentDevice = 'atk-01';
  deps = {
    packId: 'demo-pack',
    packIdOf: () => 'demo-pack',
    contractVersion: 'devboard/v1',
    hasExitCode: true,
    // **which board is the current one** (it changes)
    deviceKey: () => currentDevice,
    runTransaction: async (fn: (c: unknown) => Promise<unknown>) =>
      fn({
        exec: async (command: string) => {
          executed.push(command);
          return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
        },
      } as never),
    readTag: async (tag: string): Promise<TagReading | undefined> => ({
      tag,
      value: 100,
      unit: '',
      status: 'ok',
      at: 1_700_000_000_000,
      seq: 1,
    }),
    audit: () => {
      audits += 1;
      return 'audit-1';
    },
    now: () => 1_700_000_000_000,
    actions: () => [BACKLIGHT, REBOOT],
  } as unknown as AgentActionDeps;
});

describe('MCP · list_connections · device and connection', () => {
  it('**every connection carries a `device_key`** (**the two connections of one board get the same one**)', () => {
    const rows = listConnections(hostDeps());
    expect(rows.map((r) => r.device_key)).toEqual(['atk-01', 'atk-01', 'guest']);
  });

  it('**no `device_key` written → the default is the profile id**', () => {
    const rows = listConnections(hostDeps());
    expect(rows.find((r) => r.id === 'guest')?.device_key).toBe('guest');
  });

  it('**`current` marks the connection of the current runtime** (only then does the agent know what it may fill in)', () => {
    const rows = listConnections(hostDeps());
    expect(rows.find((r) => r.id === 'board-ssh')?.current).toBe(true);
    expect(rows.find((r) => r.id === 'board-adb')?.current).toBe(false);
  });
});

describe('MCP · execute_action · device_key', () => {
  it('**another device is given → `not_found`** (**it never silently targets the current board**)', async () => {
    const res = await executeAction(deps, 'backlight.set', { value: 100 }, { deviceKey: 'board-b' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not_found');
    // **it states which device it is**
    expect(res.detail).toContain('board-b');
    // **not a single command went out**
    expect(executed.length).toBe(0);
    expect(audits).toBe(0);
  });

  it('**the current board is given → it is done**', async () => {
    const res = await executeAction(deps, 'backlight.set', { value: 100 }, { deviceKey: 'atk-01' });
    expect(res.ok).toBe(true);
    expect(executed.length).toBe(1);
  });

  it('**nothing is given → it is done (on the current board)** (the earlier behaviour is unchanged)', async () => {
    const res = await executeAction(deps, 'backlight.set', { value: 100 });
    expect(res.ok).toBe(true);
    expect(executed.length).toBe(1);
  });

  it('**`dry_run` is blocked as well** (**it may not see the commands of another device**)', async () => {
    const res = await executeAction(deps, 'backlight.set', { value: 100 }, {
      deviceKey: 'board-b',
      dryRun: true,
    });
    expect(res.reason).toBe('not_found');
    expect(res.command).toBeUndefined();
  });
});

describe('MCP · execute_action · device_key and dangerous actions', () => {
  it('**a destructive action with another device → `not_found`** (the device check is independent of the danger level)', async () => {
    const res = await executeAction(deps, 'system.reboot', {}, { deviceKey: 'board-b' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not_found');
    // **not a single command went out** (**it never silently targets the current board**)
    expect(executed.filter((c) => c === 'reboot').length).toBe(0);
  });

  it('**a destructive action with the current board → it is done** (no prompt)', async () => {
    const res = await executeAction(deps, 'system.reboot', {}, { deviceKey: 'atk-01' });
    expect(res.ok).toBe(true);
    expect(executed.filter((c) => c === 'reboot').length).toBe(1);
  });

  it('**the board was swapped → the old device_key no longer matches** (the current board changed)', async () => {
    // **the current board becomes B** (the connection switched)
    currentDevice = 'board-b';
    const res = await executeAction(deps, 'system.reboot', {}, { deviceKey: 'atk-01' });
    // **it cannot be identified → it is refused** (**it never silently targets the new board**)
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not_found');
    expect(executed.filter((c) => c === 'reboot').length).toBe(0);
  });
});

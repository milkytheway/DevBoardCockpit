import { describe, it, expect, beforeEach } from 'vitest';
import { listConnections } from '../../../src/main/mcp/read-tools';
import { executeAction, confirmAction } from '../../../src/main/mcp/action-tools';
import { ConfirmationStore } from '../../../src/main/actions/authorization';
import type { McpHostDeps } from '../../../src/main/mcp/host';
import type { AgentActionDeps } from '../../../src/main/mcp/action-tools';
import type { ActionDef } from '../../../src/main/tags/schema';
import type { TagReading } from '../../../src/shared/tag-reading';

/**
 * **设备（板实物）与连接是两层**（契约 `spec/02` §10.2–10.3 ✓ · `spec/04` §2.1/§2.4 ✓ · ADR-D43 ✓）。
 *
 * ── 这组判据守什么 ──
 *
 * | 判据 | 为什么 |
 *---|---|
 * | **`list_connections` 带 `device_key`** ✓ | agent 才知道**哪些连接是同一块板** ✓ |
 * | **`list_connections` 带 `current`** ✓ | 不然它**不知道当前那块是谁** ✓ → `device_key` 无合法值可填 ✓ |
 * | **`execute_action` 给了别的设备 → `not_found`** ✓ | **绝不静默地打当前那块** ✓（那是「静默地做另一件事」✗） |
 * | **凭据绑住设备** ✓ | 为 A 板签的凭据**不能**拿去动 B 板 ✗ |
 */
const BACKLIGHT: ActionDef = {
  id: 'backlight.set',
  label: '设置背光亮度',
  danger: 'reversible',
  params: { value: { type: 'integer', min: 16, max: 255 } },
  guard: { value: { min: 16, max: 255 } },
  command: 'echo {value} > /sys/class/backlight/backlight/brightness',
  readback: { kind: 'tag', tag: 'custom.demo.brightness' },
};

const REBOOT: ActionDef = {
  id: 'system.reboot',
  label: '重启板子',
  danger: 'destructive',
  command: 'reboot',
  readback: { kind: 'verify', command: 'true' },
};

/** 一块板的两个连接 + 一台客机 ✓ */
const PROFILES = [
  {
    id: 'board-adb',
    label: '板子 · ADB',
    transport: 'adb' as const,
    board_pack: 'demo-pack',
    device_key: 'atk-01',
    options: {},
  },
  {
    id: 'board-ssh',
    label: '板子 · SSH',
    transport: 'ssh' as const,
    board_pack: 'demo-pack',
    device_key: 'atk-01',
    options: { host: '192.168.5.100' },
  },
  { id: 'guest', label: '客机', transport: 'ssh' as const, options: {} },
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

let confirmations: ConfirmationStore;
let executed: string[];
let audits: number;
/** **当前运行时那条连接的 `device_key`** ✓（**会变** ✓ —— 换板了 ✓） */
let currentDevice: string;
let deps: AgentActionDeps;

beforeEach(() => {
  confirmations = new ConfirmationStore();
  executed = [];
  audits = 0;
  currentDevice = 'atk-01';
  deps = {
    packId: 'demo-pack',
    packIdOf: () => 'demo-pack',
    contractVersion: 'devboard/v1',
    hasExitCode: true,
    // **当前那块板是谁** ✓（**会变** ✓）
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
    confirmations,
    audit: () => {
      audits += 1;
      return 'audit-1';
    },
    now: () => 1_700_000_000_000,
    actions: () => [BACKLIGHT, REBOOT],
  } as unknown as AgentActionDeps;
});

describe('MCP · list_connections · 设备与连接', () => {
  it('**每条连接都带 `device_key`** ✓（**同一块板的两个连接给同一个** ✓）', () => {
    const rows = listConnections(hostDeps());
    expect(rows.map((r) => r.device_key)).toEqual(['atk-01', 'atk-01', 'guest']);
  });

  it('**没写 `device_key` → 缺省是 profile id** ✓', () => {
    const rows = listConnections(hostDeps());
    expect(rows.find((r) => r.id === 'guest')?.device_key).toBe('guest');
  });

  it('**`current` 标出当前运行时那条** ✓（**agent 才知道能填什么** ✓）', () => {
    const rows = listConnections(hostDeps());
    expect(rows.find((r) => r.id === 'board-ssh')?.current).toBe(true);
    expect(rows.find((r) => r.id === 'board-adb')?.current).toBe(false);
  });
});

describe('MCP · execute_action · device_key', () => {
  it('**给了别的设备 → `not_found`** ✓（**绝不静默地打当前那块** ✓）', async () => {
    const res = await executeAction(deps, 'backlight.set', { value: 100 }, { deviceKey: 'board-b' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not_found');
    // **说清楚是哪个设备** ✓
    expect(res.detail).toContain('board-b');
    // **一个命令都没发出去** ✓
    expect(executed.length).toBe(0);
    expect(audits).toBe(0);
  });

  it('**给了当前那块 → 照做** ✓', async () => {
    const res = await executeAction(deps, 'backlight.set', { value: 100 }, { deviceKey: 'atk-01' });
    expect(res.ok).toBe(true);
    expect(executed.length).toBe(1);
  });

  it('**不给 → 照做（当前那块）** ✓（**从前的行为没变** ✓）', async () => {
    const res = await executeAction(deps, 'backlight.set', { value: 100 });
    expect(res.ok).toBe(true);
    expect(executed.length).toBe(1);
  });

  it('**`dry_run` 也照样挡** ✓（**不给它看别的设备的命令** ✓）', async () => {
    const res = await executeAction(deps, 'backlight.set', { value: 100 }, {
      deviceKey: 'board-b',
      dryRun: true,
    });
    expect(res.reason).toBe('not_found');
    expect(res.command).toBeUndefined();
  });
});

describe('MCP · confirm_action · device_key', () => {
  it('**给了别的设备 → `not_found` + 不签凭据** ✓', () => {
    const res = confirmAction(deps, 'system.reboot', {}, 'board-b');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('不该成功');
    expect(res.reason).toBe('not_found');
    expect('confirm_id' in res).toBe(false);
  });
});

describe('凭据 · 绑住设备', () => {
  it('**为 A 板签的凭据 → 换到 B 板消费不掉** ✓（**那正是要防的** ✓）', async () => {
    const res = confirmAction(deps, 'system.reboot', {});
    if (!('confirm_id' in res)) throw new Error('没有 confirm_id');
    confirmations.approve(res.confirm_id, Date.now());
    // **当前那块换成 B** ✓（**连接切了** ✓）
    currentDevice = 'board-b';
    const exec = await executeAction(deps, 'system.reboot', {}, { confirmId: res.confirm_id });
    // **凭据消费不掉** ✓ → **仍要人确认** ✓（**不是「照做」** ✗）
    expect(exec.reason).toBe('needs_confirmation');
    expect(executed.filter((c) => c === 'reboot').length).toBe(0);
  });

  it('**同一块板换一条连接 → 凭据照样能用** ✓（**绑的是板** ✓ —— 不是连接 ✓）', async () => {
    const res = confirmAction(deps, 'system.reboot', {});
    if (!('confirm_id' in res)) throw new Error('没有 confirm_id');
    confirmations.approve(res.confirm_id, Date.now());
    const exec = await executeAction(deps, 'system.reboot', {}, { confirmId: res.confirm_id });
    expect(exec.ok).toBe(true);
    expect(executed.filter((c) => c === 'reboot').length).toBe(1);
  });
});

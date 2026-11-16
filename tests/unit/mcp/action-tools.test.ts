import { describe, it, expect, beforeEach } from 'vitest';
import { executeAction, agentGrants } from '../../../src/main/mcp/action-tools';
import type { ActionDef } from '../../../src/main/tags/schema';
import type { AgentActionDeps } from '../../../src/main/mcp/action-tools';
import type { TagReading } from '../../../src/shared/tag-reading';

/**
 * **agent 的动作执行**（契约 `spec/04` §2.4 / §2.4.1 ✓ · ADR-D40 ✓）。
 *
 * ── 这组判据守什么 ──
 *
 * | 判据 | 为什么 |
 * |---|---|
 * | **动作不在包里 → `not_found`**（**不是 `denied`** ✓） | 契约 §2.4 的顺序 ✓ |
 * | **参数不合法 → `invalid_params`** ✓ | 契约 §2.4 的顺序 ✓ |
 * | **授权集里有它 → 直接执行** ✓ | 契约 §2.4.1 ✓ |
 * | **`destructive` → 也直接执行** ✓（**不再问人** ✓） | **危险等级只是信息** ✓ —— **闸在设置里的统一权限区** ✓ |
 * | **超 guard 域 → `denied`** ✓（**不是「要确认」** ✓） | **guard 是包作者划的界** ✓ |
 * | **`dry_run` 不执行、不写审计** ✓ | 「不是一次尝试」✓ |
 *
 * → **`confirm_action` 那一套没了** ✓（**2026-11-16 砍完** ✓ · ADR-D48 ✓）。
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

/**
 * **声明域宽、`guard` 窄**的动作 ✓。
 *
 * → **两者的区别** ✓（契约 §2.4 的行为表 ✓）：
 * | 越过了谁 | 返回 |
 * |---|---|
 * | **动作自己声明的域**（`params.value.min/max` ✓） | `invalid_params` ✓ |
 * | **`guard`**（装卡时批准的那一档 ✓） | **`denied`** ✓ |
 */
const DIMMER: ActionDef = {
  id: 'backlight.dim',
  label: '调暗背光',
  danger: 'reversible',
  // **声明域 0..255** ✓
  params: { value: { type: 'integer', min: 0, max: 255 } },
  // **但 guard 只批了 16..200** ✓
  guard: { value: { min: 16, max: 200 } },
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

let executed: string[];
let audits: number;
let deps: AgentActionDeps;

beforeEach(() => {
  executed = [];
  audits = 0;
  deps = {
    // **packId 是字符串** ✓（执行器要的形状 ✓）
    packId: 'demo-pack',
    packIdOf: () => 'demo-pack',
    contractVersion: 'devboard/v1',
    // **当前那块板** ✓
    deviceKey: () => 'atk-01',
    hasExitCode: true,
    runTransaction: async (fn: (c: unknown) => Promise<unknown>) =>
      fn({
        exec: async (command: string) => {
          executed.push(command);
          return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
        },
        // **verify 形式的回读会再跑一条验证命令** ✓ —— 那**不是**重复执行 ✓
      } as never),
    // **回读要读得到** ✓ —— 不然它回 `not_found` ✓（那是对的 ✓ —— 读不到就说读不到 ✓）
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
    actions: () => [BACKLIGHT, DIMMER, REBOOT],
  } as unknown as AgentActionDeps;
});

describe('MCP · execute_action · 存在性与授权', () => {
  it('**动作不在包里 → `not_found`** ✓（**不是 `denied`** ✓ —— 顺序有讲究 ✓）', async () => {
    const res = await executeAction(deps, 'nope.nope', {});
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not_found');
  });

  it('**参数不合法 → `invalid_params`** ✓（**不是执行失败** ✓）', async () => {
    const res = await executeAction(deps, 'backlight.set', { value: 9999 });
    expect(res.reason).toBe('invalid_params');
  });

  it('**agent 的授权集 = 包里的全部动作** ✓（契约 §2.4.1 ✓）', () => {
    const grants = agentGrants([BACKLIGHT, DIMMER, REBOOT]);
    expect(Object.keys(grants.actions).sort()).toEqual([
      'backlight.dim',
      'backlight.set',
      'system.reboot',
    ]);
    // **`undefined` = 批准了但没缩小参数域** ✓ → 域回落到动作自己的 guard ✓
    expect(grants.actions['backlight.set']).toBeUndefined();
  });
});

describe('MCP · execute_action · 授权的两条判据', () => {
  it('**`reversible` + 参数在 guard 域内 → 直接执行** ✓ + 记审计 ✓', async () => {
    const res = await executeAction(deps, 'backlight.set', { value: 100 });
    expect(res.ok).toBe(true);
    expect(executed.length).toBe(1);
    expect(audits).toBe(1);
    expect(res.audit_id).toBe('audit-1');
  });

  it('**`destructive` → 直接执行** ✓（**不再问人** ✓ —— ADR-D48 ✓）', async () => {
    const res = await executeAction(deps, 'system.reboot', {});
    expect(res.ok).toBe(true);
    // **命令真的跑出去了** ✓（**数的是「动作命令」** ✓ —— 回读那条验证命令不算 ✓）
    expect(executed.filter((c) => c === 'reboot').length).toBe(1);
  });

  it('**参数超出 guard 域 → `denied`** ✓（**不是「要确认」** ✓ —— **guard 是包作者划的界** ✓）', async () => {
    // **声明域 0..255 ✓ · guard 16..200 ✓** → 220 在声明域内 ✓ 但超出 guard ✓
    const res = await executeAction(deps, 'backlight.dim', { value: 220 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('denied');
    // **命令没发出去** ✓
    expect(executed.length).toBe(0);
  });

  it('**参数超出动作自己声明的域 → `invalid_params`** ✓（**那不是「超 guard」** ✓）', async () => {
    const res = await executeAction(deps, 'backlight.dim', { value: 999 });
    expect(res.reason).toBe('invalid_params');
  });

  it('**被拒了也要记一行审计** ✓（每一次尝试一行 ✓ —— 追责链不断 ✓）', async () => {
    const res = await executeAction(deps, 'backlight.dim', { value: 220 });
    expect(res.reason).toBe('denied');
    expect(audits).toBe(1);
  });
});

describe('MCP · execute_action · dry_run', () => {
  it('**返回编码后的最终命令** ✓（**不是模板** ✓）', async () => {
    const res = await executeAction(deps, 'backlight.set', { value: 100 }, { dryRun: true });
    expect(res.ok).toBe(true);
    expect(res.dry_run).toBe(true);
    expect(res.command).toBe("echo 100 > /sys/class/backlight/backlight/brightness");
  });

  it('**`destructive` 也能预览** ✓', async () => {
    const res = await executeAction(deps, 'system.reboot', {}, { dryRun: true });
    expect(res.ok).toBe(true);
    expect(res.command).toBe('reboot');
    // **预览不执行** ✓
    expect(executed.length).toBe(0);
  });

  it('**不执行** ✓ · **不写审计** ✓（「不是一次尝试」✓）', async () => {
    await executeAction(deps, 'backlight.set', { value: 100 }, { dryRun: true });
    expect(executed.length).toBe(0);
    expect(audits).toBe(0);
  });

  it('**参数不合法 → 仍然是 `invalid_params`** ✓（**不然给的不是「将要执行的」** ✓）', async () => {
    const res = await executeAction(deps, 'backlight.set', { value: 9999 }, { dryRun: true });
    expect(res.reason).toBe('invalid_params');
  });

  it('**`readback_tag` 是这个动作要读的那个** ✓', async () => {
    const res = await executeAction(deps, 'backlight.set', { value: 100 }, { dryRun: true });
    expect(res.readback_tag).toBe('custom.demo.brightness');
  });
});

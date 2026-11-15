import { describe, it, expect, beforeEach } from 'vitest';
import { executeAction, confirmAction, agentGrants } from '../../../src/main/mcp/action-tools';
import { ConfirmationStore } from '../../../src/main/actions/authorization';
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
 * | **`reversible` + 参数在 guard 域内 → 直接执行** ✓ | 契约 §2.4.1 那一档 ✓ |
 * | **`destructive` → `needs_confirmation` + `confirm_id`** ✓ | 契约 §2.4.1 ✓ |
 * | **超 guard 域 → `needs_confirmation`** ✓ | 契约 §2.4.1 ✓ |
 * | **`dry_run` 在确认之前** ✓ | 契约 §2.4 的行为表 ✓ —— 否则拿不到 destructive 的预览 ✓ |
 * | **`dry_run` 不执行、不写审计** ✓ | 「不是一次尝试」✓ |
 * | **`confirm_action` 只递请求** ✓ | 契约 §2.4.1 ✓ |
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
 * | **`guard`**（装卡时批准的那一档 ✓） | **`needs_confirmation`** ✓ |
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

let confirmations: ConfirmationStore;
let executed: string[];
let audits: number;
let deps: AgentActionDeps;

beforeEach(() => {
  confirmations = new ConfirmationStore();
  executed = [];
  audits = 0;
  deps = {
    // **packId 是字符串** ✓（执行器要的形状 ✓）—— **签发与消费绑的必须是同一个值** ✓
    packId: 'demo-pack',
    packIdOf: () => 'demo-pack',
    contractVersion: 'devboard/v1',
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
    confirmations,
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

describe('MCP · execute_action · 三档授权', () => {
  it('**`reversible` + 参数在 guard 域内 → 直接执行** ✓ + 记审计 ✓', async () => {
    const res = await executeAction(deps, 'backlight.set', { value: 100 });
    expect(res.ok).toBe(true);
    expect(executed.length).toBe(1);
    expect(audits).toBe(1);
    expect(res.audit_id).toBe('audit-1');
  });

  it('**`destructive` → `needs_confirmation` + `confirm_id`** ✓（**不执行** ✓）', async () => {
    const res = await executeAction(deps, 'system.reboot', {});
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('needs_confirmation');
    expect(res.confirm_id).toBeTruthy();
    expect(executed.length).toBe(0);
  });

  it('**参数超出 guard 域 → `needs_confirmation`** ✓（**没超出声明域** ✓）', async () => {
    // **声明域 0..255 ✓ · guard 16..200 ✓** → 220 在声明域内 ✓ 但超出 guard ✓
    const res = await executeAction(deps, 'backlight.dim', { value: 220 });
    expect(res.reason).toBe('needs_confirmation');
    expect(res.confirm_id).toBeTruthy();
  });

  it('**参数超出动作自己声明的域 → `invalid_params`** ✓（**那不是「超 guard」** ✓）', async () => {
    const res = await executeAction(deps, 'backlight.dim', { value: 999 });
    expect(res.reason).toBe('invalid_params');
  });
});

describe('MCP · execute_action · dry_run', () => {
  it('**返回编码后的最终命令** ✓（**不是模板** ✓）', async () => {
    const res = await executeAction(deps, 'backlight.set', { value: 100 }, { dryRun: true });
    expect(res.ok).toBe(true);
    expect(res.dry_run).toBe(true);
    expect(res.command).toBe("echo 100 > /sys/class/backlight/backlight/brightness");
  });

  it('**`destructive` 也能预览** ✓（**dry_run 在确认之前** ✓）', async () => {
    const res = await executeAction(deps, 'system.reboot', {}, { dryRun: true });
    expect(res.ok).toBe(true);
    expect(res.command).toBe('reboot');
    expect(res.confirm_id).toBeUndefined();
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

describe('MCP · confirm_action', () => {
  it('**只递请求** ✓ —— **凭据此刻无效** ✓（契约 §2.4.1 ✓）', async () => {
    const res = confirmAction(deps, 'system.reboot', {});
    expect(res.ok).toBe(true);
    if (!('confirm_id' in res)) throw new Error('没有 confirm_id');
    // **带它去执行 → 仍然要人确认** ✓（**没人点就永远无效** ✓）
    const exec = await executeAction(deps, 'system.reboot', {}, { confirmId: res.confirm_id });
    expect(exec.reason).toBe('needs_confirmation');
    expect(executed.length).toBe(0);
  });

  it('**人点了之后才有效** ✓', async () => {
    const res = confirmAction(deps, 'system.reboot', {});
    if (!('confirm_id' in res)) throw new Error('没有 confirm_id');
    // **人点头** ✓
    expect(confirmations.approve(res.confirm_id, Date.now())).toBe(true);
    await executeAction(deps, 'system.reboot', {}, { confirmId: res.confirm_id });
    // **`system.reboot` 的回读是 `verify` 形式** ✓ → 它会**再跑一条验证命令** ✓
    // → **数的是「动作命令」** ✓（不是总命令数 ✓ —— 那会把回读算进去 ✗）
    expect(executed.filter((c) => c === 'reboot').length).toBe(1);
  });

  it('**凭据是一次性的** ✓ —— 用过就没了 ✓（**重放 = 绕过确认** ✗）', async () => {
    const res = confirmAction(deps, 'system.reboot', {});
    if (!('confirm_id' in res)) throw new Error('没有 confirm_id');
    confirmations.approve(res.confirm_id, Date.now());
    await executeAction(deps, 'system.reboot', {}, { confirmId: res.confirm_id });
    const before = executed.filter((c) => c === 'reboot').length;
    // **同一个凭据再来一次** ✓ → **必须被拒** ✓（契约 §2.4.1：「消费即失效」✓）
    const again = await executeAction(deps, 'system.reboot', {}, { confirmId: res.confirm_id });
    expect(again.ok).toBe(false);
    expect(again.reason).toBe('needs_confirmation');
    expect(executed.filter((c) => c === 'reboot').length).toBe(before);
  });

  it('**`expires_at` 是毫秒** ✓（契约 §四 ✓）', () => {
    const res = confirmAction(deps, 'system.reboot', {});
    if (!('expires_at' in res)) throw new Error('没有 expires_at');
    expect(res.expires_at).toBeGreaterThan(1_700_000_000_000);
  });

  it('**动作不存在 → `not_found`** ✓', () => {
    const res = confirmAction(deps, 'nope', {});
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('不该成功');
    expect(res.reason).toBe('not_found');
  });

  it('**参数不合法 → `invalid_params`** ✓（**不签废凭据** ✓）', () => {
    const res = confirmAction(deps, 'backlight.set', { value: 9999 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('不该成功');
    expect(res.reason).toBe('invalid_params');
  });

  it('**不需要确认的动作 → 不递请求** ✓（**递一个没人会批的请求是噪音** ✓）', () => {
    const res = confirmAction(deps, 'backlight.set', { value: 100 });
    expect(res.ok).toBe(false);
  });
});

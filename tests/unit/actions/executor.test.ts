import { describe, it, expect } from 'vitest';
import {
  invokeAction,
  type ActionExecutorDeps,
  type Confirmations,
} from '../../../src/main/actions/executor';
import { ConfirmationStore } from '../../../src/main/actions/authorization';
import type { ActionDef } from '../../../src/main/tags/schema';
import type { Connection, ExecResult } from '../../../src/main/hal/connection';
import type { TagReading } from '../../../src/shared/tag-reading';
import type { AuditRow } from '../../../src/main/actions/audit';

/**
 * 动作执行器 —— 契约 `docs/spec/02-board-pack.md` §5.2 + `docs/21` §6.9 的七步链。
 *
 * ```
 * 编码 → 地板复查 → 授权 →（必要时）确认 → 执行 → 回读 → 审计
 * ```
 *
 * **执行与回读是一个不可拆分的独占事务**（ADR-D23 / SPEC-D22）：
 * 回读若被采样插队，读到的可能是**别的命令的输出**——
 * 「回读不符」就成了假阴性，驾驶舱会显示错的真实状态。
 */
const ACTION: ActionDef = {
  id: 'backlight.set',
  label: '设置背光',
  danger: 'reversible',
  params: { value: { type: 'integer', min: 0, max: 255 } },
  guard: { value: { min: 16, max: 255 } },
  command: 'echo {value} > /sys/class/backlight/backlight/brightness',
  readback: { kind: 'file_equals', path: '/sys/class/backlight/backlight/brightness', expect: '{value}' },
};

interface Harness {
  deps: ActionExecutorDeps;
  executed: string[];
  audits: AuditRow[];
  confirmations: string[];
}

function harness(
  over: {
    action?: ActionDef;
    fileContent?: string | null;
    execResult?: ExecResult;
    granted?: Record<string, unknown>;
    hasExitCode?: boolean;
    /** 换成**真的**凭据库 ✓（默认那个是假替身 ✓ —— 它不验摘要 ✗） */
    confirmations?: Confirmations;
  } = {},
): Harness {
  const executed: string[] = [];
  const audits: AuditRow[] = [];
  const confirmations: string[] = [];
  const action = over.action ?? ACTION;
  const fakeConn = {
    exec: async (command: string): Promise<ExecResult> => {
      executed.push(command);
      // 回读的形式 2（file_equals）在**同一条连接**上 `cat` → 要答得出内容
      if (command.startsWith('cat -- ')) {
        return { exitCode: 0, stdout: over.fileContent ?? '128', stderr: '', durationMs: 1, timedOut: false };
      }
      return (
        over.execResult ?? {
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: 1,
          timedOut: false,
        }
      );
    },
  };
  const deps: ActionExecutorDeps = {
    packId: 'rk3588-atk',
    contractVersion: 'devboard/v1',
    hasExitCode: over.hasExitCode ?? true,
    runTransaction: async <T>(fn: (conn: Connection) => Promise<T>): Promise<T> =>
      fn(fakeConn as unknown as Connection),
    readTag: async (): Promise<TagReading | undefined> => undefined,
    granted: () => ({
      actions: {
        [action.id]: action.guard ?? undefined,
      },
    }),
    confirmations: over.confirmations ?? {
      issue: (
        _actionId: string,
        _params: Record<string, unknown>,
        _packId: string,
        _contractVersion: string,
        _now: number,
        _commandDigest: string,
      ): string => {
        const token = `confirm-${confirmations.length}`;
        confirmations.push(token);
        return token;
      },
      consume: (): boolean => false,
      approve: (): boolean => true,
      request: (): boolean => true,
    },
    audit: (row: AuditRow): string => {
      audits.push(row);
      return `audit-${audits.length}`;
    },
  };
  return { deps, executed, audits, confirmations };
}

describe('执行器 · 正常路径', () => {
  it('执行 + 回读 + 审计一行', async () => {
    const h = harness();
    const result = await invokeAction(ACTION, { value: 128 }, h.deps);
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    // 执行 + 回读读文件（cat）—— **都在同一条连接上**
    expect(h.executed[0]).toContain('echo 128 >');
    // 回读读文件 = 在**同一条连接**上 `cat`（路径按 shell 规则加了引号）
    expect(h.executed[1]).toBe("cat -- '/sys/class/backlight/backlight/brightness'");
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]?.actionId).toBe('backlight.set');
  });

  it('**执行的是编码后的命令**（参数被引号包住）', async () => {
    const h = harness();
    await invokeAction(ACTION, { value: 128 }, h.deps);
    expect(h.executed[0]).toBe("echo 128 > /sys/class/backlight/backlight/brightness");
  });

  it('string 参数按单引号注入（注入面被关上）', async () => {
    const withString: ActionDef = {
      ...ACTION,
      id: 'note.set',
      params: { text: { type: 'string', maxLength: 64 } },
      command: 'echo {text} > /tmp/note',
      readback: { kind: 'none', consequence: '写了个文件' },
    };
    const h = harness({ action: withString });
    await invokeAction(withString, { text: 'x; reboot' }, h.deps);
    expect(h.executed[0]).toBe("echo 'x; reboot' > /tmp/note");
  });

  it('审计行里有**最终命令**（追责的第一环 ✓）', async () => {
    const h = harness();
    await invokeAction(ACTION, { value: 128 }, h.deps);
    // **命令是编码过的** ✓（参数被引号包住 ✓）
    expect(h.audits[0]?.command).toBe('echo 128 > /sys/class/backlight/backlight/brightness');
  });

  it('审计行里有**参数**与**回读值**', async () => {
    const h = harness();
    await invokeAction(ACTION, { value: 128 }, h.deps);
    expect(h.audits[0]?.params).toEqual({ value: 128 });
    expect(h.audits[0]?.value).toBe('128');
  });

  it('结果里的回读值与审计行里的**是同一个值**', async () => {
    const h = harness();
    const result = await invokeAction(ACTION, { value: 128 }, h.deps);
    expect(result.readback?.value).toBe(h.audits[0]?.value);
  });

  it('回读不符 → 不是 ok，而且 verified 是 false', async () => {
    const h = harness({ fileContent: '100' });
    const result = await invokeAction(ACTION, { value: 128 }, h.deps);
    expect(result.ok).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('readback_mismatch');
  });
});

describe('执行器 · 结果形状（**按契约**）', () => {
  it('回读到的值在 `readback` 里（契约 spec/04 §2.4 / spec/03 §5.2）', async () => {
    const h = harness();
    const result = await invokeAction(ACTION, { value: 128 }, h.deps);
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    // **不是平铺的 `result.value`**——契约写的是 `readback.value`
    expect(result.readback?.value).toBe('128');
  });

  it('结果里有 `audit_id`（追责单位）', async () => {
    const h = harness();
    const result = await invokeAction(ACTION, { value: 128 }, h.deps);
    expect(result.audit_id).toBe('audit-1');
  });

  it('回读不符 → 带 `expected` / `actual`（契约的失败形状）', async () => {
    const h = harness({ fileContent: '100' });
    const result = await invokeAction(ACTION, { value: 128 }, h.deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('readback_mismatch');
    expect(result.expected).toBe('128');
    expect(result.actual).toBe('100');
  });
});

describe('执行器 · 回读的验证命令也要过地板', () => {
  it('**verify 的命令命中危险地板 → 不执行**（包给的命令不能借「验证」之名跑危险命令）', async () => {
    const dangerous: ActionDef = {
      ...ACTION,
      id: 'probe',
      command: 'echo hi',
      readback: { kind: 'verify', command: 'rm -rf /' },
    };
    const h = harness({ action: dangerous });
    await expect(invokeAction(dangerous, { value: 128 }, h.deps)).rejects.toThrow(/危险地板/);
    // **那条危险命令没发出去** ✓
    expect(h.executed.some((c) => c.includes('rm -rf'))).toBe(false);
  });
});

describe('执行器 · 授权与确认', () => {
  it('destructive → 要人确认（**命令不执行**）', async () => {
    const destructive: ActionDef = { ...ACTION, danger: 'destructive' };
    const h = harness({ action: destructive });
    const result = await invokeAction(destructive, { value: 128 }, h.deps);
    expect(result.needsConfirmation).toBeTruthy();
    expect(h.executed).toHaveLength(0);
  });

  it('**地板命中** → 当成 destructive（要人确认，命令不执行）', async () => {
    // 包里声明的是 `reversible`，但**编码后的命令**命中了地板
    const dangerous: ActionDef = {
      ...ACTION,
      id: 'wipe.root',
      command: 'rm -rf /',
      params: {},
      readback: { kind: 'none', consequence: '删根' },
    };
    const h = harness({ action: dangerous });
    const result = await invokeAction(dangerous, {}, h.deps);
    expect(result.needsConfirmation).toBeTruthy();
    expect(h.executed).toHaveLength(0);
  });

  it('参数超出批准域 → 要人确认（不是拒绝）', async () => {
    const h = harness();
    const result = await invokeAction(ACTION, { value: 5 }, h.deps);
    expect(result.needsConfirmation).toBeTruthy();
    expect(result.ok).toBe(false);
  });

  it('没被授权的动作 → denied，命令不执行', async () => {
    const h = harness();
    h.deps.granted = () => ({ actions: {} });
    const result = await invokeAction(ACTION, { value: 128 }, h.deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('denied');
    expect(h.executed).toHaveLength(0);
  });

  it('带**对得上的** confirm_id → 直接执行', async () => {
    const h = harness();
    h.deps.confirmations = {
      issue: () => 'confirm-0',
      consume: () => true,
      approve: () => true,
      request: () => true,
    };
    const result = await invokeAction(
      { ...ACTION, danger: 'destructive' },
      { value: 128 },
      h.deps,
      { confirmId: 'confirm-0' },
    );
    expect(result.ok).toBe(true);
    // 执行 + 回读读文件（cat）—— 都在同一条连接上
    expect(h.executed.length).toBeGreaterThan(0);
  });

  it('带**对不上**的 confirm_id → 还是要确认', async () => {
    const h = harness();
    const result = await invokeAction(
      { ...ACTION, danger: 'destructive' },
      { value: 128 },
      h.deps,
      { confirmId: 'wrong' },
    );
    expect(result.needsConfirmation).toBeTruthy();
    expect(h.executed).toHaveLength(0);
  });
});

describe('执行器 · 回读形式 5', () => {
  it('none → ok 但 verified:false（不报失败，也不装作验证了）', async () => {
    const led: ActionDef = {
      ...ACTION,
      id: 'led.blink',
      readback: { kind: 'none', consequence: '点亮板载 LED 约 1 秒' },
    };
    const h = harness({ action: led });
    const result = await invokeAction(led, { value: 128 }, h.deps);
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(false);
  });
});

describe('确认凭据 · 绑住**这一步的最终命令**（契约 spec/05 §7.5-3 ✓）', () => {
  it('**命令变了 → 那张凭据用不了**（→ 得重新点头 ✓ —— 独立评审 40 的 I-5 ✓）', async () => {
    const store = new ConfirmationStore();
    const h = harness({ confirmations: store });
    const dangerous = { ...ACTION, danger: 'destructive' as const };

    // **第一次** → 签发凭据 ✓（命令是 A ✓）
    const first = await invokeAction(dangerous, { value: 128 }, h.deps);
    const confirmId = first.needsConfirmation?.confirmId ?? '';
    expect(confirmId).toBeTruthy();
    // **人点了** ✓
    expect(store.approve(confirmId, Date.now())).toBe(true);

    // **命令变了** ✓（同一个动作、同一组参数，但命令模板不同 ✓）
    const changed = { ...dangerous, command: 'echo {value} > /tmp/other' };
    const second = await invokeAction(changed, { value: 128 }, h.deps, { confirmId });

    // **那张凭据认不出这条命令** ✓ → 重新要一次确认 ✓
    expect(second.reason).toBe('needs_confirmation');
    expect(second.needsConfirmation?.confirmId).not.toBe(confirmId);
  });

  it('**命令没变 → 那张凭据用得了** ✓', async () => {
    const store = new ConfirmationStore();
    const h = harness({ confirmations: store });
    const dangerous = { ...ACTION, danger: 'destructive' as const };
    const first = await invokeAction(dangerous, { value: 128 }, h.deps);
    const confirmId = first.needsConfirmation?.confirmId ?? '';
    store.approve(confirmId, Date.now());
    const second = await invokeAction(dangerous, { value: 128 }, h.deps, { confirmId });
    // **真跑起来了** ✓（不是又要确认 ✓）
    expect(second.ok).toBe(true);
  });
});

describe('执行器 · 执行与回读不可拆分', () => {
  it('回读在**同一个事务**里（runTransaction 只被调一次）', async () => {
    const h = harness();
    let transactions = 0;
    const base = h.deps.runTransaction;
    h.deps.runTransaction = async <T>(fn: (conn: Connection) => Promise<T>): Promise<T> => {
      transactions += 1;
      return base(fn);
    };
    await invokeAction(ACTION, { value: 128 }, h.deps);
    expect(transactions).toBe(1);
  });
});

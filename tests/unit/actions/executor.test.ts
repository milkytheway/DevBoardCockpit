import { describe, it, expect } from 'vitest';
import { invokeAction, type ActionExecutorDeps } from '../../../src/main/actions/executor';
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
    confirmations: {
      issue: (
        _actionId: string,
        _params: Record<string, unknown>,
        _packId: string,
        _contractVersion: string,
        _now: number,
      ): string => {
        const token = `confirm-${confirmations.length}`;
        confirmations.push(token);
        return token;
      },
      consume: (): boolean => false,
    },
    audit: (row: AuditRow): void => {
      audits.push(row);
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

  it('审计行里有**参数**与**回读值**', async () => {
    const h = harness();
    await invokeAction(ACTION, { value: 128 }, h.deps);
    expect(h.audits[0]?.params).toEqual({ value: 128 });
    expect(h.audits[0]?.value).toBe('128');
  });

  it('回读不符 → 不是 ok，而且 verified 是 false', async () => {
    const h = harness({ fileContent: '100' });
    const result = await invokeAction(ACTION, { value: 128 }, h.deps);
    expect(result.ok).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('readback_mismatch');
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

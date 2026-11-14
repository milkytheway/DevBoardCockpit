import { describe, it, expect } from 'vitest';
import { TargetRegistry } from '../../../src/main/workflows/targets';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';
import type { Connection, ExecResult } from '../../../src/main/hal/connection';

/**
 * 目标登记处 —— **role → 连接**。
 *
 * ── 为什么需要它 ──
 *
 * M6 的执行器**只能用运行时那一条连接**（板子）。
 * 而「在客机上跑一条 scp」（直传，ADR-D31 R7）**要的是另一条连接**。
 * → 计划 5 的 A17 写了「执行器要能对指定的连接执行」，**接线一直没做** ✗。
 * → 这一层就是补那个缺口：**按 profile id 拿到连接**，并且**每个目标一条线**。
 *
 * ── 三条规矩 ──
 *
 * 1. **一个目标一条线**：每个 profile 一条连接 + **它自己的队列**
 *    （串口是一根线；两条目标各走各的 ✓）。
 * 2. **profile 不存在 → 报错**：绝不悄悄连到别的目标 ✓。
 * 3. **同一个目标复用同一条连接**：不每次重开（重开要 10 秒 ✗）。
 */
function profile(id: string): ConnectionProfile {
  return { id, label: id, transport: 'ssh', options: { host: '10.0.0.1' } };
}

interface Fake extends Connection {
  readonly commands: string[];
  closed: boolean;
}

function fakeConnection(id: string, commands: string[]): Fake {
  // **用闭包变量记状态**（不用 `this`——对象字面量里的 `this` 类型推不出来）
  const state = { closed: false };
  const conn = {
    id,
    transport: 'ssh',
    commands,
    get closed(): boolean {
      return state.closed;
    },
    capabilities: () => ({ exec: true, files: true, exitCode: true, pty: false }),
    open: async () => undefined,
    close: async () => {
      state.closed = true;
    },
    exec: async (command: string): Promise<ExecResult> => {
      commands.push(command);
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
    },
    pull: async () => undefined,
    push: async () => undefined,
    list: async () => [],
    openSession: async () => {
      throw new Error('测试里不开会话');
    },
  } as unknown as Fake;
  return conn;
}

function registry(ids: string[] = ['guest', 'board']) {
  const created: Fake[] = [];
  const profiles = ids.map(profile);
  const reg = new TargetRegistry({
    profileFor: (id) => profiles.find((p) => p.id === id),
    createConnection: (p) => {
      const conn = fakeConnection(p.id, []);
      created.push(conn);
      return conn;
    },
  });
  return { reg, created };
}

describe('目标登记处 · 取得连接', () => {
  it('同一个 profile id → **同一条连接**（复用，不重开）', async () => {
    const { reg, created } = registry();
    const a = await reg.connectionFor('guest');
    const b = await reg.connectionFor('guest');
    expect(a).toBe(b);
    expect(created).toHaveLength(1);
  });

  it('两个 profile → **两条连接**（各走各的线）', async () => {
    const { reg, created } = registry();
    const guest = await reg.connectionFor('guest');
    const board = await reg.connectionFor('board');
    expect(guest).not.toBe(board);
    expect(created).toHaveLength(2);
  });

  it('**profile 不存在 → 报错**（绝不悄悄连到别的目标）', async () => {
    const { reg } = registry();
    await expect(reg.connectionFor('nobody')).rejects.toThrow(/nobody/);
  });

  it('连接建好后**真的 open 过**', async () => {
    let opened = 0;
    const reg = new TargetRegistry({
      profileFor: (id) => profile(id),
      createConnection: () => {
        const conn = fakeConnection('x', []);
        conn.open = async () => {
          opened += 1;
        };
        return conn;
      },
    });
    await reg.connectionFor('guest');
    expect(opened).toBe(1);
  });
});

describe('目标登记处 · 独占事务', () => {
  it('在目标上跑一条命令，**命令发到那条线上**', async () => {
    const { reg } = registry();
    await reg.runOn('guest', async (conn) => conn.exec('make'));
    const guest = await reg.connectionFor('guest');
    expect((guest as Fake).commands).toEqual(['make']);
  });

  it('**两个目标各跑各的**（不串台）', async () => {
    const { reg } = registry();
    await reg.runOn('guest', async (conn) => conn.exec('on-guest'));
    await reg.runOn('board', async (conn) => conn.exec('on-board'));
    const guest = (await reg.connectionFor('guest')) as Fake;
    const board = (await reg.connectionFor('board')) as Fake;
    expect(guest.commands).toEqual(['on-guest']);
    expect(board.commands).toEqual(['on-board']);
  });

  it('**同一个目标上的两次往返不并发**（一条线一次只能有一个）', async () => {
    const { reg } = registry();
    const order: string[] = [];
    const slow = async (label: string, ms: number): Promise<void> => {
      order.push(`${label}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${label}:end`);
    };
    await Promise.all([
      reg.runOn('guest', async () => slow('a', 40)),
      reg.runOn('guest', async () => slow('b', 5)),
    ]);
    // **不许交错**：a 结束之后 b 才开始
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('事务失败 → 错误**照原样抛出来**（不吞）', async () => {
    const { reg } = registry();
    await expect(
      reg.runOn('guest', async () => {
        throw new Error('炸了');
      }),
    ).rejects.toThrow(/炸了/);
  });
});

describe('目标登记处 · 收摊', () => {
  it('closeAll 把**每条连接都关掉**', async () => {
    const { reg, created } = registry();
    await reg.connectionFor('guest');
    await reg.connectionFor('board');
    await reg.closeAll();
    expect(created.every((c) => c.closed)).toBe(true);
    expect(reg.openCount).toBe(0);
  });

  it('关掉之后**再取会重新开**（不是拿着关掉的连接继续用）', async () => {
    const { reg, created } = registry();
    const first = await reg.connectionFor('guest');
    await reg.closeAll();
    const second = await reg.connectionFor('guest');
    expect(second).not.toBe(first);
    expect(created).toHaveLength(2);
  });
});

import { describe, it, expect } from 'vitest';
import { TargetRegistry } from '../../../src/main/workflows/targets';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';
import type { Connection, ExecResult } from '../../../src/main/hal/connection';

/**
 * The registry of the targets — **role → connection**.
 *
 * Why it is needed:
 *
 * The executor of M6 could **only use the one connection of the runtime** (the
 * board), while "running an scp on the guest" (a direct transfer) **needs
 * another connection**.
 * → The A17 of plan 5 wrote "the executor has to be able to run on a given
 *   connection" and **the wiring was never done**.
 * → This layer closes that gap: **it gets the connection by the profile id**
 *   and **every target has its own line**.
 *
 * Three rules:
 *
 * 1. **One line per target**: one connection per profile + **its own queue**
 *    (a serial port is one line; two targets each go their own way).
 * 2. **The profile does not exist → it reports an error**: it never quietly
 *    connects to another target.
 * 3. **The same target reuses the same connection**: it is not opened again
 *    every time (opening it again takes 10 seconds).
 */
function profile(id: string): ConnectionProfile {
  return { id, label: id, transport: 'ssh', options: { host: '10.0.0.1' } };
}

interface Fake extends Connection {
  readonly commands: string[];
  closed: boolean;
}

function fakeConnection(id: string, commands: string[]): Fake {
  // **The state is kept in a closure** (not in `this` — the type of `this` in an object literal cannot be inferred)
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
      throw new Error('no session in the test');
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

describe('the registry of the targets · it gets a connection', () => {
  it('the same profile id → **the same connection** (it is reused, it is not opened again)', async () => {
    const { reg, created } = registry();
    const a = await reg.connectionFor('guest');
    const b = await reg.connectionFor('guest');
    expect(a).toBe(b);
    expect(created).toHaveLength(1);
  });

  it('two profiles → **two connections** (each on its own line)', async () => {
    const { reg, created } = registry();
    const guest = await reg.connectionFor('guest');
    const board = await reg.connectionFor('board');
    expect(guest).not.toBe(board);
    expect(created).toHaveLength(2);
  });

  it('**the profile does not exist → it reports an error** (it never quietly connects to another target)', async () => {
    const { reg } = registry();
    await expect(reg.connectionFor('nobody')).rejects.toThrow(/nobody/);
  });

  it('the connection was really opened once it was built', async () => {
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

describe('the registry of the targets · the exclusive transaction', () => {
  it('a command runs on a target, **the command goes onto that line**', async () => {
    const { reg } = registry();
    await reg.runOn('guest', async (conn) => conn.exec('make'));
    const guest = await reg.connectionFor('guest');
    expect((guest as Fake).commands).toEqual(['make']);
  });

  it('**two targets each run their own** (no crossed wires)', async () => {
    const { reg } = registry();
    await reg.runOn('guest', async (conn) => conn.exec('on-guest'));
    await reg.runOn('board', async (conn) => conn.exec('on-board'));
    const guest = (await reg.connectionFor('guest')) as Fake;
    const board = (await reg.connectionFor('board')) as Fake;
    expect(guest.commands).toEqual(['on-guest']);
    expect(board.commands).toEqual(['on-board']);
  });

  it('**two round trips on the same target do not run at the same time** (one line carries one at a time)', async () => {
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
    // **They may not interleave**: b only starts after a ended
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('when the transaction fails the error is **thrown as it is** (it is not swallowed)', async () => {
    const { reg } = registry();
    await expect(
      reg.runOn('guest', async () => {
        throw new Error('it blew up');
      }),
    ).rejects.toThrow(/it blew up/);
  });
});

describe('the registry of the targets · closing up', () => {
  it('closeAll closes **every connection**', async () => {
    const { reg, created } = registry();
    await reg.connectionFor('guest');
    await reg.connectionFor('board');
    await reg.closeAll();
    expect(created.every((c) => c.closed)).toBe(true);
    expect(reg.openCount).toBe(0);
  });

  it('after it was closed **getting it again opens it anew** (it does not go on with a closed connection)', async () => {
    const { reg, created } = registry();
    const first = await reg.connectionFor('guest');
    await reg.closeAll();
    const second = await reg.connectionFor('guest');
    expect(second).not.toBe(first);
    expect(created).toHaveLength(2);
  });
});

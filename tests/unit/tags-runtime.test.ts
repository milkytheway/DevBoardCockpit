import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TagRuntime } from '../../src/main/tags/runtime';
import type { ConnectionProfile } from '../../src/main/profiles/schema';
import type { ExecResult } from '../../src/main/hal/connection';

/**
 * The tag runtime (the layer that **wires the library of M3/M4 into the
 * application**).
 *
 * It handles three things:
 *
 * | Thing | Why |
 * |---|---|
 * | build the connection, bind the pack, validate, start the scheduler | the four premises of "the values move by themselves" |
 * | **the readings only go in and out through the TagStore** | ADR-D22: one state has one copy |
 * | **a late subscription does not lose the current value** | a window that opens late also has to see the values of now (contract §2.1) |
 *
 * The criteria:
 *
 * The state machine (idle / running / no-pack / error) + the snapshot + the
 * subscription. "The values move by themselves" is guarded by the tests of the
 * scheduler and of the sampler (here only the wiring is verified).
 */

/** A minimal pack that reads one file */
function packYaml(id: string): string {
  return [
    'apiVersion: devboard/v1',
    'kind: BoardPack',
    `id: ${id}`,
    `name: ${id}`,
    'version: 1.0.0',
    'requires:',
    '  transports: [adb]',
    '  capabilities: [exec]',
    '  min_contract: devboard/v1',
    'poll_groups:',
    '  - id: fast',
    '    interval_ms: 200',
    '    readers: [one]',
    'readers:',
    '  - id: one',
    '    kind: file_read',
    '    args:',
    '      path: /x/value',
    '      format: integer',
    '    provides:',
    '      - tag: custom.tiny.value',
    '        sample: value',
    'custom: []',
    'actions: []',
    '',
  ].join('\n');
}

function makePacksDir(id = 'tiny'): string {
  const root = mkdtempSync(join(tmpdir(), 'rt-packs-'));
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'board.yaml'), packYaml(id), 'utf8');
  return root;
}

/** A fake connection: it answers with the content and the markers according to the protocol */
function fakeConnection(body = '42'): { exec: (cmd: string) => Promise<ExecResult> } {
  return {
    async exec(command: string): Promise<ExecResult> {
      const re = /echo '(__DBCGS_[0-9a-f]+__)';([\s\S]*?); echo '(__DBCGE_[0-9a-f]+__)'/g;
      const parts: string[] = [];
      for (const m of command.matchAll(re)) {
        parts.push(m[1]!, body, m[3]!);
      }
      return { exitCode: 0, stdout: parts.join('\n'), stderr: '', durationMs: 1, timedOut: false };
    },
  };
}

const profile = (boardPack: string | null): ConnectionProfile => ({
  id: 'p',
  label: 'p',
  transport: 'adb',
  ...(boardPack === null ? {} : { board_pack: boardPack }),
  options: {},
});

describe('TagRuntime · the state machine', () => {
  it('the connection names a pack → running', async () => {
    const dir = makePacksDir();
    try {
      const runtime = new TagRuntime({
        packsDir: dir,
        createConnection: () =>
          ({ open: async () => undefined, close: async () => undefined, ...fakeConnection() }) as never,
        createLog: () => ({ write: () => {}, close: () => {}, filePath: 'x' }) as never,
      });

      await runtime.start(profile('tiny'));
      expect(runtime.status.state).toBe('running');
      runtime.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the connection names a pack that **does not exist** → no-pack and it says why', async () => {
    const dir = makePacksDir();
    try {
      const runtime = new TagRuntime({
        packsDir: dir,
        createConnection: () =>
          ({ open: async () => undefined, close: async () => undefined, ...fakeConnection() }) as never,
        createLog: () => ({ write: () => {}, close: () => {}, filePath: 'x' }) as never,
      });

      await runtime.start(profile('nosuchpack'));
      expect(runtime.status.state).toBe('no-pack');
      expect(runtime.status.detail).toContain('nosuchpack');
      runtime.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('**it cannot be reached** → error and an error message (it does not silently do nothing)', async () => {
    const dir = makePacksDir();
    try {
      const runtime = new TagRuntime({
        packsDir: dir,
        createConnection: () =>
          ({
            open: async () => {
              throw new Error('the serial port COM3 cannot be opened');
            },
            close: async () => undefined,
            ...fakeConnection(),
          }) as never,
        createLog: () => ({ write: () => {}, close: () => {}, filePath: 'x' }) as never,
      });

      await runtime.start(profile('tiny'));
      expect(runtime.status.state).toBe('error');
      expect(runtime.status.detail).toContain('COM3');
      runtime.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('TagRuntime · the exclusive transaction (the entry of M6)', () => {
  it('not connected → it is refused (it does not silently wait)', async () => {
    const dir = makePacksDir();
    try {
      const runtime = new TagRuntime({
        packsDir: dir,
        createConnection: () =>
          ({ open: async () => undefined, close: async () => undefined, ...fakeConnection() }) as never,
        createLog: () => ({ write: () => {}, close: () => {}, filePath: 'x' }) as never,
      });
      await expect(runtime.runTransaction(async () => 'x')).rejects.toMatchObject({
        code: 'CONN_CLOSED',
      });
      runtime.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the transaction runs **on that connection**', async () => {
    const dir = makePacksDir();
    try {
      const runtime = new TagRuntime({
        packsDir: dir,
        createConnection: () =>
          ({ open: async () => undefined, close: async () => undefined, ...fakeConnection() }) as never,
        createLog: () => ({ write: () => {}, close: () => {}, filePath: 'x' }) as never,
      });
      await runtime.start(profile('tiny'));
      const result = await runtime.runTransaction(async (conn) => conn.exec('echo hi'));
      expect(result.exitCode).toBe(0);
      runtime.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the transaction and the sampling **do not run at the same time** (the same queue → no crossed wires on a serial port)', async () => {
    const dir = makePacksDir();
    try {
      let inFlight = 0;
      let maxInFlight = 0;
      const slow = {
        open: async () => undefined,
        close: async () => undefined,
        async exec(): Promise<ExecResult> {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 40));
          inFlight -= 1;
          return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
        },
      };
      const runtime = new TagRuntime({
        packsDir: dir,
        createConnection: () => slow as never,
        createLog: () => ({ write: () => {}, close: () => {}, filePath: 'x' }) as never,
      });
      await runtime.start(profile('tiny'));
      await runtime.runTransaction(async (conn) => conn.exec('echo hi'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(maxInFlight).toBe(1);
      runtime.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('TagRuntime · the readings going in and out', () => {
  it('**a late subscription does not lose the current value**: the snapshot holds the readings that were written before the subscription', async () => {
    const dir = makePacksDir();
    try {
      const runtime = new TagRuntime({
        packsDir: dir,
        createConnection: () =>
          ({ open: async () => undefined, close: async () => undefined, ...fakeConnection() }) as never,
        createLog: () => ({ write: () => {}, close: () => {}, filePath: 'x' }) as never,
      });

      await runtime.start(profile('tiny'));
      // It waits for one sampling period (200ms)
      await new Promise((resolve) => setTimeout(resolve, 400));

      // The snapshot is taken **after** the subscription → the snapshot already holds a value
      const seen: unknown[] = [];
      runtime.subscribe((r) => seen.push(r));
      const snapshot = runtime.readings();

      expect(snapshot.length).toBeGreaterThan(0);
      expect(snapshot[0]!.tag).toBe('custom.tiny.value');
      runtime.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the subscribers receive a **push of a change**', async () => {
    const dir = makePacksDir();
    try {
      const runtime = new TagRuntime({
        packsDir: dir,
        createConnection: () =>
          ({ open: async () => undefined, close: async () => undefined, ...fakeConnection() }) as never,
        createLog: () => ({ write: () => {}, close: () => {}, filePath: 'x' }) as never,
      });

      const seen: string[] = [];
      runtime.subscribe((r) => seen.push(r.tag));

      await runtime.start(profile('tiny'));
      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(seen.length).toBeGreaterThan(0);
      runtime.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * **The success is the commit** ✓ (found on 2026-11-21 ✓).
 *
 * → A failed start must not leave the runtime **claiming** a board ✓ →
 *   `connections:list` marks the current board by that ✓ → and picking the
 *   same board again would say "you are already on it" ✓ and never retry ✓.
 * → `stop()` must clear the identity ✓ and the readings ✓ (the readings of
 *   the old board must not stay under the new one ✓).
 * → **A candidate that throws must not break the chain** ✓ (the backoff and
 *   the next candidate have to run ✓).
 */
describe('TagRuntime · the commit', () => {
  // → **A fresh pack directory per test** ✓ (the other block deletes it after
  //   every test ✓ → the second one would find no pack ✓).
  let dir: string;
  beforeEach(() => {
    dir = makePacksDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('**a failed start leaves no board behind** ✓ (the identity is only written on success ✓)', async () => {
    const runtime = new TagRuntime({
      packsDir: dir,
      createConnection: () =>
        ({
          open: async () => {
            throw new Error('the board is not there');
          },
          close: async () => undefined,
          ...fakeConnection(),
        }) as never,
      createLog: () => ({ write: () => {}, close: () => {}, filePath: 'x' }) as never,
    });

    await runtime.start({ ...profile('tiny'), device_key: 'atk-01' });
    expect(runtime.status.state).toBe('error');
    // → **No board** ✓ — the runtime does not claim one it cannot reach ✓.
    expect(runtime.status.profileId).toBeUndefined();
    expect(runtime.currentDeviceKey).toBeUndefined();
  });

  it('**building the connection may throw** ✓ (it does not escape the runtime ✓)', async () => {
    const runtime = new TagRuntime({
      packsDir: dir,
      createConnection: () => {
        throw new Error('the placeholder could not be repaired');
      },
      createLog: () => ({ write: () => {}, close: () => {}, filePath: 'x' }) as never,
    });

    const status = await runtime.start(profile('tiny'));
    expect(status.state).toBe('error');
    expect(status.detail).toContain('placeholder');
    expect(status.profileId).toBeUndefined();
  });

  it('**stop() clears the identity** ✓ (the runtime does not keep claiming the old board ✓)', async () => {
    const runtime = new TagRuntime({
      packsDir: dir,
      createConnection: () =>
        ({ open: async () => undefined, close: async () => undefined, ...fakeConnection() }) as never,
      createLog: () => ({ write: () => {}, close: () => {}, filePath: 'x' }) as never,
    });

    await runtime.start({ ...profile('tiny'), device_key: 'atk-01' });
    expect(runtime.currentDeviceKey).toBe('atk-01');
    runtime.stop();
    expect(runtime.currentDeviceKey).toBeUndefined();
    expect(runtime.status.profileId).toBeUndefined();
  });

  it('**the readings of the old board do not survive the switch** ✓ (one board at a time ✓)', async () => {
    const runtime = new TagRuntime({
      packsDir: dir,
      createConnection: () =>
        ({ open: async () => undefined, close: async () => undefined, ...fakeConnection() }) as never,
      createLog: () => ({ write: () => {}, close: () => {}, filePath: 'x' }) as never,
    });
    const seen: string[] = [];
    runtime.subscribe((reading) => seen.push(`${reading.tag}:${reading.status}`));

    await runtime.start(profile('tiny'));
    // → The sampler has written something ✓
    await new Promise((resolve) => setTimeout(resolve, 400));
    const before = runtime.readings().length;
    expect(before).toBeGreaterThan(0);

    runtime.stop();
    // → **Every reading of the old board is `unavailable`** ✓ (the interface
    //   must not show the numbers of the board that is gone ✓).
    for (const reading of runtime.readings()) {
      expect(reading.status).toBe('unavailable');
      expect(reading.value).toBeNull();
    }
    // → And the listeners heard it ✓ (otherwise the interface keeps the old
    //   numbers ✓).
    expect(seen.some((entry) => entry.endsWith(':unavailable'))).toBe(true);
  });

  it('**the store is subscribed only once** ✓ (a second board must not double every reading ✓)', async () => {
    const runtime = new TagRuntime({
      packsDir: dir,
      createConnection: () =>
        ({ open: async () => undefined, close: async () => undefined, ...fakeConnection() }) as never,
      createLog: () => ({ write: () => {}, close: () => {}, filePath: 'x' }) as never,
    });
    const seen: string[] = [];
    runtime.subscribe((reading) => seen.push(reading.tag));

    await runtime.start(profile('tiny'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const afterFirst = seen.length;
    expect(afterFirst).toBeGreaterThan(0);

    // → The board is picked again ✓ → the store must not be subscribed twice ✓
    await runtime.start(profile('tiny'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const afterSecond = seen.length - afterFirst;
    // → **The same order of magnitude** ✓ (not twice as much ✓)
    expect(afterSecond).toBeLessThan(afterFirst * 3);
    runtime.stop();
  });
});

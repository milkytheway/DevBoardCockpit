import { describe, it, expect, beforeEach } from 'vitest';
import { TerminalManager } from '../../../src/main/terminal/manager';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';
import type { Connection } from '../../../src/main/hal/connection';
import type { SessionLog } from '../../../src/main/logging/session-log';
import type { Session } from '../../../src/main/hal/session';

/**
 * **The decision of a live connection** (the `connected` of contract
 * `spec/04` §2.1).
 *
 * Why this layer exists:
 *
 * `connected` has to answer "**does this profile have a live connection
 * right now**" — a profile is **configuration**, a connection is an
 * **instance**.
 *
 * → The host side **has no registry of connections** — the connections are
 *   indexed by **sessionId** (the `connections` Map of `main/index.ts`, it
 *   is there for the "file transfer").
 * → **Indexing by profileId would clash** — the same profile can open two
 *   terminal tabs (the code comment mentions that pitfall: it was indexed by
 *   profileId once and closing one made the other unfindable).
 *
 * → Therefore **the `TerminalManager` records which profile every live
 *   session belongs to** and exposes "which profiles have a live session".
 *
 * One important distinction:
 *
 * **"the runtime remembers this profile" is not "connected"** —
 * `TagRuntime.status.profileId` still has a value when it **cannot be
 * reached** (`state = 'error'`) and when it **has stopped** (`state =
 * 'idle'`). → Therefore `connected` **may not look at that alone**.
 */

const PROFILES: ConnectionProfile[] = [
  { id: 'guest', label: 'the guest', transport: 'ssh', options: {} },
  { id: 'board', label: 'the board', transport: 'adb', options: {} },
];

function fakeConnection(): Connection {
  return {
    id: 'x',
    transport: 'ssh',
    capabilities: () => ({ exec: true, files: true, exitCode: true, pty: false }),
    open: async () => undefined,
    close: async () => undefined,
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false }),
    pull: async () => undefined,
    push: async () => undefined,
    list: async () => [],
    openSession: async () => ({ onData: () => undefined, onExit: () => undefined, write: () => undefined, resize: () => undefined, close: () => undefined }),
  } as unknown as Connection;
}

describe('TerminalManager · the live profiles', () => {
  let manager: TerminalManager;

  beforeEach(() => {
    manager = new TerminalManager({
      listProfiles: () => PROFILES,
      createConnection: () => fakeConnection(),
      createLog: (): SessionLog => ({ write: () => undefined, writeEvent: () => undefined, close: () => undefined }) as unknown as SessionLog,
    });
  });

  it('**without a session it is an empty list**', () => {
    expect(manager.liveProfileIds()).toEqual([]);
  });

  it('**a session was opened → that profile is in the list**', async () => {
    await manager.open('guest');
    expect(manager.liveProfileIds()).toEqual(['guest']);
  });

  it('**two sessions → both profiles are there**', async () => {
    await manager.open('guest');
    await manager.open('board');
    expect(manager.liveProfileIds().sort()).toEqual(['board', 'guest']);
  });

  it('**two tabs of the same profile → it appears only once in the list** (the list answers "which profiles are connected")', async () => {
    await manager.open('guest');
    await manager.open('guest');
    expect(manager.liveProfileIds()).toEqual(['guest']);
  });

  it('**a session was closed → that profile is gone**', async () => {
    const { sessionId } = await manager.open('guest');
    await manager.close(sessionId);
    expect(manager.liveProfileIds()).toEqual([]);
  });

  it('**one of the tabs was closed → the other is still there → the profile is still there**', async () => {
    const first = await manager.open('guest');
    await manager.open('guest');
    await manager.close(first.sessionId);
    expect(manager.liveProfileIds()).toEqual(['guest']);
  });

  it('**the remote side exited → the profile is gone as well**', async () => {
    // **The callback is caught on its own** — `vi.fn()` only records and does not call (that was the pitfall of my first version)
    let exitCb: ((code: number | null) => void) | undefined;
    const manager2 = new TerminalManager({
      listProfiles: () => PROFILES,
      createConnection: () => {
        const conn = fakeConnection();
        conn.openSession = async () =>
          ({
            onData: () => undefined,
            onExit: (cb: (code: number | null) => void) => {
              exitCb = cb;
            },
            write: () => undefined,
            resize: () => undefined,
            close: () => undefined,
          }) as unknown as Session;
        return conn;
      },
      createLog: (): SessionLog => ({ write: () => undefined, writeEvent: () => undefined, close: () => undefined }) as unknown as SessionLog,
    });
    await manager2.open('guest');
    expect(manager2.liveProfileIds()).toEqual(['guest']);
    expect(exitCb).toBeTruthy();
    exitCb?.(0);
    // **The cleanup of a session is asynchronous** (`closeSession` has to `await connection.close()` first
    //   — the close of a serial port is asynchronous — and only then it is removed from the table)
    // → **It is polled until it settles** (not "wait a tick" — that would be betting on the timing)
    for (let i = 0; i < 50 && manager2.liveProfileIds().length > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(manager2.liveProfileIds()).toEqual([]);
  });
});

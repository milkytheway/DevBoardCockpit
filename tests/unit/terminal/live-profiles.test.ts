import { describe, it, expect, beforeEach } from 'vitest';
import { TerminalManager } from '../../../src/main/terminal/manager';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';
import type { Connection } from '../../../src/main/hal/connection';
import type { SessionLog } from '../../../src/main/logging/session-log';
import type { Session } from '../../../src/main/hal/session';

/**
 * **活连接的判定**（契约 `spec/04` §2.1 的 `connected` ✓ · ADR-D40 ✓）。
 *
 * ── 为什么要有这一层 ──
 *
 * `connected` 要答的是「**这条 profile 现在有活着的连接吗**」✓
 * —— profile 是**配置** ✓，连接是**实例** ✓。
 *
 * → 宿主侧**没有连接 registry** ✓ —— 连接按 **sessionId** 索引 ✓
 *   （`main/index.ts` 的 `connections` Map ✓ · 它是给「文件互传」用的 ✓）。
 * → **按 profileId 索引会撞** ✓ —— 同一个 profile 可以开两个终端标签 ✓
 *   （代码注释里明写过这个坑 ✓ —— 曾经按 profileId 索引导致「关掉一个另一个找不到了」✓）。
 *
 * → 所以：**`TerminalManager` 记下每个活会话是哪个 profile** ✓，
 *   并暴露「哪些 profile 现在有活会话」✓。
 *
 * ── 一条重要的区分 ──
 *
 * **「运行时记着这个 profile」≠「连着」** ✓ ——
 * `TagRuntime.status.profileId` 在**连不上**（`state = 'error'` ✓）
 * 与**已停下**（`state = 'idle'` ✓）时**仍然有值** ✓。
 * → 所以 `connected` **不能只看它** ✓（评审 I-1 ✓）。
 */

const PROFILES: ConnectionProfile[] = [
  { id: 'guest', label: '客机', transport: 'ssh', options: {} },
  { id: 'board', label: '板子', transport: 'adb', options: {} },
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

describe('TerminalManager · 活着的 profile', () => {
  let manager: TerminalManager;

  beforeEach(() => {
    manager = new TerminalManager({
      listProfiles: () => PROFILES,
      createConnection: () => fakeConnection(),
      createLog: (): SessionLog => ({ write: () => undefined, writeEvent: () => undefined, close: () => undefined }) as unknown as SessionLog,
    });
  });

  it('**没有会话时是空列表** ✓', () => {
    expect(manager.liveProfileIds()).toEqual([]);
  });

  it('**开了会话 → 那条 profile 在列表里** ✓', async () => {
    await manager.open('guest');
    expect(manager.liveProfileIds()).toEqual(['guest']);
  });

  it('**两个会话 → 两个 profile 都在** ✓', async () => {
    await manager.open('guest');
    await manager.open('board');
    expect(manager.liveProfileIds().sort()).toEqual(['board', 'guest']);
  });

  it('**同一个 profile 开两个标签 → 列表里只出现一次** ✓（它是「有哪些 profile 连着」✓）', async () => {
    await manager.open('guest');
    await manager.open('guest');
    expect(manager.liveProfileIds()).toEqual(['guest']);
  });

  it('**关掉一个会话 → 那条 profile 不在了** ✓', async () => {
    const { sessionId } = await manager.open('guest');
    await manager.close(sessionId);
    expect(manager.liveProfileIds()).toEqual([]);
  });

  it('**关掉其中一个标签 → 另一个还在 → profile 还在** ✓', async () => {
    const first = await manager.open('guest');
    await manager.open('guest');
    await manager.close(first.sessionId);
    expect(manager.liveProfileIds()).toEqual(['guest']);
  });

  it('**远端自己退出 → profile 也不在了** ✓', async () => {
    // **单独捕获回调** ✓ —— `vi.fn()` 只记录不调用 ✓（那是我第一版的坑 ✓）
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
    // **会话的清理是异步的** ✓（`closeSession` 要先 `await connection.close()` ✓
    //   —— 串口的 close 是异步的 ✓ —— 之后才从表里删掉 ✓）
    // → **轮询等它落定** ✓（不是「等一拍」✓ —— 那赌的是时序 ✓）
    for (let i = 0; i < 50 && manager2.liveProfileIds().length > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(manager2.liveProfileIds()).toEqual([]);
  });
});

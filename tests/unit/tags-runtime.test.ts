import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TagRuntime } from '../../src/main/tags/runtime';
import type { ConnectionProfile } from '../../src/main/profiles/schema';
import type { ExecResult } from '../../src/main/hal/connection';

/**
 * tag 运行时（把 M3/M4 的库**接进应用**的那一层）。
 *
 * ── 它管三件事 ──
 *
 * | 事 | 为什么 |
 * |---|---|
 * | 建连接、绑包、校验、起调度器 | 「值要自己会动」的四个前提 |
 * | **只经 TagStore 进出读数** | ADR-D22：一份状态只有一份副本 |
 * | **晚订阅不丢当前值** | 晚打开的窗口也该看到现在的数（契约 §2.1） |
 *
 * ── 判据 ──
 *
 * 状态机（idle / running / no-pack / error）+ 快照 + 订阅。
 * 「值自己在动」由**调度器与采样器**各自的测试守着（这里只验接线）。
 */

/** 一个只读一个文件的最小包 */
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

/** 一个假的连接：按协议回带 marker 的内容 */
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

describe('TagRuntime · 状态机', () => {
  it('连接指名了包 → running', async () => {
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

  it('连接指名了**不存在的**包 → no-pack + 说清为什么', async () => {
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

  it('**连不上** → error + 错误消息（不是静默什么都不做）', async () => {
    const dir = makePacksDir();
    try {
      const runtime = new TagRuntime({
        packsDir: dir,
        createConnection: () =>
          ({
            open: async () => {
              throw new Error('打不开串口 COM3');
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

describe('TagRuntime · 独占事务（M6 的入口）', () => {
  it('没连上 → 拒（不是静默等着）', async () => {
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

  it('事务跑在**那条连接**上', async () => {
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

  it('事务与采样**不并发**（同一条队列 → 串口上不串台）', async () => {
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

describe('TagRuntime · 读数的进出', () => {
  it('**晚订阅不丢当前值**：快照里有订阅之前就写进去的读数', async () => {
    const dir = makePacksDir();
    try {
      const runtime = new TagRuntime({
        packsDir: dir,
        createConnection: () =>
          ({ open: async () => undefined, close: async () => undefined, ...fakeConnection() }) as never,
        createLog: () => ({ write: () => {}, close: () => {}, filePath: 'x' }) as never,
      });

      await runtime.start(profile('tiny'));
      // 等一个采样周期（200ms）
      await new Promise((resolve) => setTimeout(resolve, 400));

      // 订阅**之后**取快照 → 快照里已经有值了
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

  it('订阅者能收到**变化推送**', async () => {
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

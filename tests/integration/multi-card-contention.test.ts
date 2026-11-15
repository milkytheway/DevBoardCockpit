import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardSessionManager } from '../../src/main/cards/session';
import { TagRuntime } from '../../src/main/tags/runtime';
import { invokeAction } from '../../src/main/actions/executor';
import type { ConnectionProfile } from '../../src/main/profiles/schema';
import type { ExecResult } from '../../src/main/hal/connection';
import type { ActionDef } from '../../src/main/tags/schema';

/**
 * **两张卡片抢同一块板子**（多卡片运行时的调度 ✓）。
 *
 * ── 为什么这条要存在 ──
 *
 * 卡片**不各持连接** ✓ —— 它们调动作都走**运行时那一条连接 + 那一个队列** ✓
 * （`main/index.ts` 的 `actionsFor` → `runtime.runTransaction` ✓）。
 * → 所以两张卡同时动同一块板子**不会串台** ✓（串口上尤其要紧 ✓ —— 事实 S1 ✓）。
 *
 * → **但这条性质一直没有判据** ✓ → 哪天有人给卡片「各开一条连接」✓，
 * 串口上的「点了按钮，监控卡数值乱跳」就会回来 ✓（契约 `spec/02` §1.2.1 点名的症状 ✓）。
 *
 * ── 它盯的是什么 ──
 *
 * → **同一时刻只有一次往返在飞** ✓（不是「两张卡各自不交错」✓ —— 那是**同一条连接**上的性质 ✓）。
 */

/** 一个能起来的板型包（运行时要真的有一个包才起得来 ✓） */
function makePacksDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-contention-'));
  const dir = join(root, 'tiny');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'board.yaml'),
    [
      'apiVersion: devboard/v1',
      'kind: BoardPack',
      'id: tiny',
      'name: tiny',
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
    ].join('\n'),
    'utf8',
  );
  return root;
}

const PROFILE: ConnectionProfile = {
  id: 'p',
  label: '板子',
  transport: 'adb',
  board_pack: 'tiny',
  options: {},
};

const ACTION: ActionDef = {
  id: 'act.set',
  label: '设置',
  danger: 'reversible',
  params: { value: { type: 'integer', min: 0, max: 255 } },
  command: 'echo {value}',
  readback: { kind: 'none', consequence: '没有可回读的状态' },
};

describe('两张卡片 · 同一块板子', () => {
  it('**同时调动作 → 往返不交错**（同一条队列 ✓ —— 串口上不串台 ✓）', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const conn = {
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

    const packsDir = makePacksDir();
    const runtime = new TagRuntime({
      packsDir,
      createConnection: () => conn as never,
      createLog: () => ({ write: () => {}, close: () => {}, filePath: 'x' }) as never,
    });
    await runtime.start(PROFILE);

    const manager = new CardSessionManager({
      runtime: runtime as never,
      permsFor: () => ({ read: [], write: [ACTION.id], workflows: [] }),
      // **两张卡的动作都走运行时那一条连接** ✓（与 main/index.ts 同形 ✓）
      actionsFor: () => ({
        invoke: (id: string, params: Record<string, unknown>) =>
          invokeAction(
            { ...ACTION, id },
            params,
            {
              packId: 'tiny',
              contractVersion: 'devboard/v1',
              // **当前那块板** ✓（凭据要绑它 ✓ —— 契约 `spec/04` §2.4.1 第六项 ✓）
              deviceKey: () => 'tiny-board',
              hasExitCode: true,
              runTransaction: (fn) => runtime.runTransaction(fn),
              readTag: async () => undefined,
              granted: () => ({ actions: { [ACTION.id]: undefined } }),
              confirmations: {
                issue: () => '',
                consume: () => false,
                approve: () => false,
                request: () => false,
                revoke: () => false,
              },
              audit: () => 'audit-1',
              actor: 'card:test',
            },
          ),
      }),
    });

    manager.open('inst-a', 'card-a', 'p');
    manager.open('inst-b', 'card-b', 'p');

    await Promise.all([
      manager.handle({
        instanceId: 'inst-a',
        id: 'r1',
        method: 'actions.invoke',
        args: { id: ACTION.id, params: { value: 1 } },
      }),
      manager.handle({
        instanceId: 'inst-b',
        id: 'r2',
        method: 'actions.invoke',
        args: { id: ACTION.id, params: { value: 2 } },
      }),
    ]);

    // **同一时刻只有一次往返在飞** ✓
    expect(maxInFlight).toBe(1);
    runtime.stop();
    rmSync(packsDir, { recursive: true, force: true });
  });
});

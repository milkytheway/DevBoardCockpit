import { describe, it, expect, beforeEach } from 'vitest';
import { TagStore } from '../../../src/main/tags/store';
import { runWorkflow, type WorkflowRunDeps } from '../../../src/main/workflows/runner';
import { parseWorkflow } from '../../../src/main/workflows/format';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';
import type { Connection, ExecResult } from '../../../src/main/hal/connection';

/**
 * **落位目录不该问用不上的事实**（契约 `05` §九 规则 9 ✓ · ADR-D43 ✓）。
 *
 * ── 原来的毛病 ──
 *
 * `resolveEndpoints` **无条件**去问目标机器 `uname -r` ✓ —— 哪怕落位是
 * `user-program`（`/usr/local/bin/` ✓ —— **固定路径** ✓，**根本不需要内核版本** ✓）。
 *
 * → 后果：**多一次往返** ✓ + **宿主必须能连上目标机器** ✓
 * → 而「宿主只有 ADB 没有板子私钥」时 ✓ —— **那条路走不通** ✗。
 *
 * → **只有 `kernel-module` 的落位需要内核版本** ✓（`/usr/lib/modules/<版本>/extra/` ✓）。
 */
describe('工作流 · 落位目录不问用不上的事实', () => {
  const PROFILE: ConnectionProfile = {
    id: 'board',
    label: '板子',
    transport: 'adb',
    board_pack: 'rk3588-atk',
    options: { serial: 'x' },
  };

  let unameCalls: number;
  let deps: WorkflowRunDeps;

  beforeEach(() => {
    unameCalls = 0;
    const conn = {
      id: 'board',
      transport: 'adb',
      capabilities: () => ({ exec: true, files: true, exitCode: true, pty: false }),
      open: async () => undefined,
      close: async () => undefined,
      exec: async (command: string): Promise<ExecResult> => {
        if (command === 'uname -r') {
          unameCalls += 1;
          return { exitCode: 0, stdout: '6.1.141\n', stderr: '', durationMs: 1, timedOut: false };
        }
        return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
      },
      pull: async () => undefined,
      push: async () => undefined,
      list: async () => [],
      openSession: async () => {
        throw new Error('不开会话');
      },
    } as unknown as Connection;

    deps = {
      targets: {
        runOn: async <T>(profileId: string, fn: (c: Connection) => Promise<T>): Promise<T> => {
          if (profileId !== 'board') throw new Error(`没有这个连接：${profileId}`);
          return fn(conn);
        },
        closeAll: async () => undefined,
      } as unknown as WorkflowRunDeps['targets'],
      profileFor: (id: string) => (id === 'board' ? PROFILE : undefined),
      audit: () => 'audit-1',
    };
  });

  const TRANSFER_PACK = {
    apiVersion: 'devboard/v1',
    kind: 'Workflow',
    id: 'demo.transfer',
    name: '演示传输',
    version: '1.0.0',
    inputs: {},
    roles: {
      build: { purpose: '客机', profile: 'guest' },
      target: { purpose: '板子', profile: 'board' },
    },
    steps: [
      {
        id: 'deliver',
        kind: 'file.transfer',
        from: { role: 'build', path: '/tmp/x' },
        to: { role: 'target', placement: 'user-program' },
        cmd: 'scp {from.path} {role:target.user}@{role:target.host}:{to.path}',
      },
    ],
  };

  it('**`user-program` 的落位 → 不问 `uname -r`** ✓（**固定路径** ✓ —— 问了就是白问 ✓）', async () => {
    const pack = parseWorkflow(TRANSFER_PACK, 'demo.yaml');
    await runWorkflow(pack, {}, deps);
    expect(unameCalls).toBe(0);
  });

  it('**`kernel-module` 的落位 → 要问 `uname -r`** ✓（**路径里有版本号** ✓）', async () => {
    const pack = parseWorkflow(
      {
        ...TRANSFER_PACK,
        steps: [
          {
            ...(TRANSFER_PACK.steps[0] as Record<string, unknown>),
            to: { role: 'target', placement: 'kernel-module' },
          },
        ],
      },
      'demo.yaml',
    );
    await runWorkflow(pack, {}, deps);
    expect(unameCalls).toBe(1);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { runWorkflow, type WorkflowRunDeps } from '../../../src/main/workflows/runner';
import { parseWorkflow } from '../../../src/main/workflows/format';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';
import type { Connection, ExecResult } from '../../../src/main/hal/connection';

/**
 * The placement directory must not ask for facts it does not need (contract
 * `05` §9 rule 9).
 *
 * The old fault:
 *
 * `resolveEndpoints` asked the target machine for `uname -r`
 * **unconditionally** — even when the placement is `user-program`
 * (`/usr/local/bin/` — **a fixed path**, **the kernel version is not needed
 * at all**).
 *
 * → The consequence: **one round trip more** and **the host has to be able
 *   to reach the target machine**, while with "the host only has ADB and not
 *   the private key of the board" **that route does not work**.
 *
 * → **Only the placement `kernel-module` needs the kernel version**
 *   (`/usr/lib/modules/<version>/extra/`).
 */
describe('the workflow · the placement directory does not ask for facts it does not need', () => {
  const PROFILE: ConnectionProfile = {
    id: 'board',
    label: 'the board',
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
        throw new Error('no session');
      },
    } as unknown as Connection;

    deps = {
      targets: {
        runOn: async <T>(profileId: string, fn: (c: Connection) => Promise<T>): Promise<T> => {
          if (profileId !== 'board') throw new Error(`no such connection: ${profileId}`);
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
    name: 'demo transfer',
    version: '1.0.0',
    inputs: {},
    roles: {
      build: { purpose: 'the guest', profile: 'guest' },
      target: { purpose: 'the board', profile: 'board' },
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

  it('**the placement of `user-program` → it does not ask for `uname -r`** (**a fixed path** — asking would be asking for nothing)', async () => {
    const pack = parseWorkflow(TRANSFER_PACK, 'demo.yaml');
    await runWorkflow(pack, {}, deps);
    expect(unameCalls).toBe(0);
  });

  it('**the placement of `kernel-module` → it has to ask for `uname -r`** (**the path carries the version**)', async () => {
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

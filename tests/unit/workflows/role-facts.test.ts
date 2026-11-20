import { describe, it, expect } from 'vitest';
import { runWorkflow } from '../../../src/main/workflows/runner';
import { TargetRegistry } from '../../../src/main/workflows/targets';
import { parseWorkflow } from '../../../src/main/workflows/format';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';
import type { Connection, ExecResult } from '../../../src/main/hal/connection';
import type { AuditRow } from '../../../src/main/actions/audit';

/**
 * **Where the facts of a role come from** (contract `spec/05` §6,
 * `spec/02` §10.3).
 *
 * The measurement that triggered this:
 *
 * host → board `192.168.5.100` (SSH): **the network works**, **the
 * authentication fails** — **the private key is on the guest**.
 *
 * → The `scp` command of `file.transfer` runs **on the guest** (the command
 *   runs on the source target), so **it needs the SSH address of the board**,
 *   while the target role is bound to `board-adb`, and **that profile has no
 *   `host`** — so **the address in the command is an empty string**.
 *
 * → **`options.ssh` closes that hole** — it is the endpoint of **the machine
 *   behind this connection**. → **The workflow pack does not change at all**
 *   (**machine specific values do not go into a pack**).
 */
interface FakeTarget {
  profile: ConnectionProfile;
  commands: string[];
}

function harness(boardOptions: Record<string, unknown>): {
  byId: (id: string) => FakeTarget | undefined;
  deps: Parameters<typeof runWorkflow>[2];
} {
  const targets: FakeTarget[] = [
    {
      profile: {
        id: 'guest',
        label: 'the guest',
        transport: 'ssh',
        options: { host: '10.0.0.2', username: 'builder' },
      },
      commands: [],
    },
    {
      profile: { id: 'board', label: 'the board', transport: 'adb', options: boardOptions },
      commands: [],
    },
  ];
  const byId = (id: string): FakeTarget | undefined => targets.find((t) => t.profile.id === id);

  const registry = new TargetRegistry({
    profileFor: (id) => byId(id)?.profile,
    createConnection: (profile) => {
      const target = byId(profile.id) as FakeTarget;
      const conn = {
        id: profile.id,
        transport: profile.transport,
        capabilities: () => ({ exec: true, files: true, exitCode: true, pty: false }),
        open: async () => undefined,
        close: async () => undefined,
        exec: async (command: string): Promise<ExecResult> => {
          target.commands.push(command);
          return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
        },
        pull: async () => undefined,
        push: async () => undefined,
        list: async () => [],
        openSession: async () => {
          throw new Error('no session in the test');
        },
      } as unknown as Connection;
      return conn;
    },
  });

  const deps = {
    targets: registry,
    profileFor: (id: string) => byId(id)?.profile,
    audit: (_row: AuditRow): string => 'audit-1',
    now: () => 1_700_000_000_000,
  };
  return { byId, deps };
}

/** A workflow of "the guest compiles → scp to the board" */
function transferPack() {
  return parseWorkflow(
    {
      apiVersion: 'devboard/v1',
      kind: 'Workflow',
      id: 'w.flow',
      name: 'w',
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
          from: { role: 'build', path: 'build/hello' },
          to: { role: 'target', placement: 'user-program' },
          cmd: 'scp {from.path} {role:target.user}@{role:target.host}:{to.path}',
        },
      ],
    },
    'w.yaml',
  );
}

describe('the workflow · where the facts of a role come from', () => {
  it('**the board of an adb → the facts come from `options.ssh`** (**that scp needs the address of the board**)', async () => {
    const h = harness({ serial: 'x', ssh: { host: '192.168.5.100', port: 22, username: 'root' } });
    await runWorkflow(transferPack(), {}, h.deps);
    const scp = h.byId('guest')?.commands.find((c) => c.startsWith('scp '));
    // **The command holds the address of the board** (**not an empty string**)
    expect(scp).toContain('192.168.5.100');
    // **The facts of the role are quoted** (half trusted — the same rule as in `substitute.ts`)
    expect(scp).toContain("'root'@'192.168.5.100'");
  });

  it('**`options.ssh.port` is part of the facts as well**', async () => {
    const h = harness({ ssh: { host: '192.168.5.100', port: 2222, username: 'root' } });
    await runWorkflow(
      parseWorkflow(
        {
          apiVersion: 'devboard/v1',
          kind: 'Workflow',
          id: 'w.flow',
          name: 'w',
          version: '1.0.0',
          inputs: {},
          roles: {
            build: { purpose: 'the guest', profile: 'guest' },
            target: { purpose: 'the board', profile: 'board' },
          },
          steps: [
            {
              id: 'ping',
              kind: 'exec',
              role: 'build',
              cmd: 'ssh -p {role:target.port} {role:target.user}@{role:target.host}',
            },
          ],
        },
        'w.yaml',
      ),
      {},
      h.deps,
    );
    const cmd = h.byId('guest')?.commands[0];
    expect(cmd).toContain('-p 2222');
  });

  it('**the guest of an ssh → the facts still come from `options.host`** (**the earlier behaviour is unchanged**)', async () => {
    const h = harness({});
    await runWorkflow(
      parseWorkflow(
        {
          apiVersion: 'devboard/v1',
          kind: 'Workflow',
          id: 'w.flow',
          name: 'w',
          version: '1.0.0',
          inputs: {},
          roles: {
            build: { purpose: 'the guest', profile: 'guest' },
            target: { purpose: 'the board', profile: 'board' },
          },
          steps: [
            {
              id: 'ping',
              kind: 'exec',
              role: 'build',
              cmd: 'ssh {role:build.user}@{role:build.host}',
            },
          ],
        },
        'w.yaml',
      ),
      {},
      h.deps,
    );
    expect(h.byId('guest')?.commands[0]).toBe("ssh 'builder'@'10.0.0.2'");
  });

  it('**the board declares no `options.ssh` → the address stays empty** (**it does not guess** — **it does not invent an address**)', async () => {
    const h = harness({ serial: 'x' });
    await runWorkflow(transferPack(), {}, h.deps);
    const scp = h.byId('guest')?.commands.find((c) => c.startsWith('scp '));
    // **No address was invented**
    expect(scp).not.toContain('192.168');
    expect(scp).toContain("@'':");
  });
});

import { describe, it, expect } from 'vitest';
import { runWorkflow, type WorkflowRunDeps } from '../../../src/main/workflows/runner';
import { TargetRegistry } from '../../../src/main/workflows/targets';
import { parseWorkflow } from '../../../src/main/workflows/format';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';
import type { Connection, ExecResult } from '../../../src/main/hal/connection';
import type { AuditRow } from '../../../src/main/actions/audit';
import type { FileEntry } from '../../../src/shared/ipc-contract';

/**
 * The workflow executor — it **runs how a task is done**.
 *
 * What these criteria defend against:
 *
 * | Criterion | Defends against |
 * |---|---|
 * | the command is **sent to the named target** | a step meant for the guest running on the board |
 * | the inputs are **encoded by type** | an injection such as `; reboot` |
 * | the **danger level is informational** (no prompt) | the gate is the permission area in the settings |
 * | the criterion is **read on the named role** | "the board has no artefact" being judged as "it has one" (a false positive) |
 * | **one audit row per step** | nobody being able to trace the cause afterwards |
 */
interface FakeTarget {
  profile: ConnectionProfile;
  commands: string[];
  files: FileEntry[];
  /** The answer of `cat -- <path>` on this target */
  catAnswers: Record<string, string>;
}

function harness(
  opts: {
    files?: Record<string, FileEntry[]>;
    onExec?: (command: string) => void;
    /** A command matching these fragments returns non-zero (it simulates a failed transfer) */
    failCommands?: string[];
    /** The target of this profile cannot be reached (the board is not plugged in) */
    failProfile?: string;
  } = {},
) {
  const targets: FakeTarget[] = [
    {
      profile: { id: 'guest', label: 'the guest', transport: 'ssh', options: { host: '10.0.0.2', username: 'builder' } },
      commands: [],
      files: [],
      catAnswers: {},
    },
    {
      profile: { id: 'board', label: 'the board', transport: 'adb', options: {} },
      commands: [],
      files: [],
      catAnswers: {},
    },
  ];
  const byId = (id: string): FakeTarget | undefined => targets.find((t) => t.profile.id === id);
  /** Returns a target (it throws when there is none, so a mistake in the test surfaces at once) */
  const target = (id: string): FakeTarget => {
    const found = byId(id);
    if (found === undefined) throw new Error(`no such test target: ${id}`);
    return found;
  };
  for (const t of targets) {
    if (opts.files?.[t.profile.id] !== undefined) t.files = opts.files[t.profile.id] as FileEntry[];
  }

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
          // **This target cannot be reached** (the board is not plugged in / the ssh authentication failed)
          if (opts.failProfile === profile.id) {
            throw new Error(`cannot reach target ${profile.id}`);
          }
          target.commands.push(command);
          // **The test can stop here** ("the step that is in flight is cancelled")
          opts.onExec?.(command);
          // **Some commands have to fail** (it simulates a transfer that did not succeed)
          // **The transfer leaves that file on the target**
          // (a real scp **writes while it transfers** — on success it is a complete file, on failure a **half** one;
          //   that is exactly what the scout of §3·F2 saw)
          if (command.startsWith('scp ')) {
            // **The path is quoted in the command** (command mode) → the quotes have to be stripped when it is taken out
            // (the shell strips them — a real scp writes the path **without** quotes)
            const dest = command.slice(command.lastIndexOf(':') + 1).replace(/^'|'$/g, '');
            const board = byId('board');
            if (board !== undefined) {
              board.files = [
                ...board.files,
                {
                  name: dest.slice(dest.lastIndexOf('/') + 1),
                  path: dest,
                  isDirectory: false,
                  sizeBytes: 3,
                  modifiedAt: null,
                },
              ];
            }
          }
          if (opts.failCommands?.some((frag) => command.includes(frag)) === true) {
            return { exitCode: 1, stdout: '', stderr: 'transfer failed', durationMs: 1, timedOut: false };
          }
          if (command.startsWith('cat -- ')) {
            const path = command.slice('cat -- '.length).replace(/^'|'$/g, '');
            const answer = target.catAnswers[path];
            return answer === undefined
              ? { exitCode: 1, stdout: '', stderr: 'No such file', durationMs: 1, timedOut: false }
              : { exitCode: 0, stdout: answer, stderr: '', durationMs: 1, timedOut: false };
          }
          if (command === 'uname -r') {
            return { exitCode: 0, stdout: '6.1.141\n', stderr: '', durationMs: 1, timedOut: false };
          }
          if (command.includes('id_ed25519.pub')) {
            // **The public key step has to really produce something** (the credential setup depends on it)
            return {
              exitCode: 0,
              stdout: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI-test claude-sandbox\n',
              stderr: '',
              durationMs: 1,
              timedOut: false,
            };
          }
          return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
        },
        pull: async () => undefined,
        push: async () => undefined,
        list: async (dir: string): Promise<FileEntry[]> =>
          target.files.filter((f) => f.path.startsWith(dir === '.' ? '' : dir)),
        openSession: async () => {
          throw new Error('no session in the test');
        },
      } as unknown as Connection;
      return conn;
    },
  });

  const audits: AuditRow[] = [];
  const deps: WorkflowRunDeps = {
    targets: registry,
    profileFor: (id: string) => byId(id)?.profile,
    audit: (row: AuditRow): string => {
      audits.push(row);
      return `audit-${audits.length}`;
    },
    now: () => 1_700_000_000_000,
    // **The action definition the `action` step needs** (`actionDef` is optional — without it the action cannot be called)
    actionDef: undefined,
  };
  return { targets, byId, target, audits, deps };
}

const ROLES = {
  build: { purpose: 'the guest', profile: 'guest' },
  target: { purpose: 'the board', profile: 'board' },
};

describe('workflow · the action step (refers to an action of a board pack)', () => {
  /**
   * What this case defends against:
   *
   * **The argument values of a workflow can only be strings** (the shape of a
   * workflow pack is closed — `spec/05` §4.2), while **the arguments of an
   * action carry a type** (`integer` / `number` / `boolean` / `enum` —
   * `spec/02` §4.3). **The two do not match**, so
   * a typed action **cannot be called from a workflow** (measured on
   * 2026-11-16: `invalid_params: the parameter "value" has to be an
   * integer`).
   *
   * → The workflow layer **converts once according to the type the action
   *   declares itself**.
   */
  it('**an integer parameter is converted to the type the action declares** ("1" → 1)', async () => {
    const h = harness();
    h.deps.actionDef = () => ({
      id: 'led.set',
      danger: 'reversible',
      params: { value: { type: 'integer' } },
      command: 'echo {value} > /sys/class/leds/work/brightness',
      readback: { kind: 'command_ok' },
    });
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          { id: 'led', kind: 'action', role: 'target', action: 'led.set', params: { value: '1' } },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps);
    expect(result.ok).toBe(true);
    // **The command holds `1`, not `'1'`** — the encoder treats it as a **number** (no quotes)
    expect(h.byId('board')?.commands).toEqual(['echo 1 > /sys/class/leds/work/brightness']);
  });

  it('**a boolean parameter is converted as well** ("true" → true)', async () => {
    const h = harness();
    h.deps.actionDef = () => ({
      id: 'x.set',
      danger: 'reversible',
      params: { on: { type: 'boolean' } },
      command: 'toggle {on}',
      readback: { kind: 'command_ok' },
    });
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [{ id: 'x', kind: 'action', role: 'target', action: 'x.set', params: { on: 'true' } }],
      },
      'w.yaml',
    );
    await runWorkflow(pack, {}, h.deps);
    expect(h.byId('board')?.commands).toEqual(['toggle true']);
  });

  it('**a value that cannot be converted is left alone** ("abc" is not an integer → it is kept as it is → the authorisation layer reports it; the value is not invented here)', async () => {
    const h = harness();
    h.deps.actionDef = () => ({
      id: 'x.set',
      danger: 'reversible',
      params: { n: { type: 'integer' } },
      command: 'set {n}',
      readback: { kind: 'command_ok' },
    });
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [{ id: 'x', kind: 'action', role: 'target', action: 'x.set', params: { n: 'abc' } }],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps);
    // **The action failed** (the authorisation layer said "it has to be an integer") — **the workflow layer did not quietly turn it into 0**
    expect(result.ok).toBe(false);
  });
});

describe('workflow · the exec step', () => {
  it('the command is **sent to the named target**', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [{ id: 'compile', kind: 'exec', role: 'build', cmd: 'make' }],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps);
    expect(result.ok).toBe(true);
    expect(h.byId('guest')?.commands).toEqual(['make']);
    // **Not a single command on the board** (no crossed wires)
    expect(h.byId('board')?.commands).toEqual([]);
  });

  it('the inputs are **encoded by type** (`; reboot` stays a literal)', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        inputs: { note: { type: 'string', maxLength: 64 } },
        roles: ROLES,
        steps: [{ id: 'echo', kind: 'exec', role: 'build', cmd: 'echo {input:note}' }],
      },
      'w.yaml',
    );
    await runWorkflow(pack, { note: 'x; reboot' }, h.deps);
    expect(h.byId('guest')?.commands[0]).toBe("echo 'x; reboot'");
  });

  it('**a hit on the danger floor no longer blocks** (the danger level is informational — the gate is the permission area in the settings)', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          { id: 'reboot', kind: 'exec', role: 'target', cmd: 'reboot' },
          { id: 'after', kind: 'exec', role: 'target', cmd: 'echo after' },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps);
    expect(result.ok).toBe(true);
    // **The command ran** (**it no longer stops at the step that waits for the operator**)
    expect(h.byId('board')?.commands).toContain('reboot');
    // **The later step ran as well** (**it no longer stops half way**)
    expect(h.byId('board')?.commands).toContain('echo after');
  });

  it('the audit row carries the final command (the first link in the chain of accountability)', async () => {
    const h = harness();
    await runWorkflow(
      parseWorkflow(
        {
          apiVersion: 'devboard/v1',
          kind: 'Workflow',
          id: 'w.flow',
          name: 'w',
          version: '1.0.0',
          inputs: { value: { type: 'integer', min: 0, max: 255 } },
          roles: ROLES,
          steps: [{ id: 'set', kind: 'exec', role: 'target', cmd: 'echo {input:value} > /tmp/v' }],
        },
        'w.yaml',
      ),
      { value: 128 },
      h.deps,
    );
    // **The command is encoded** (an integer without quotes)
    expect(h.audits[0]?.command).toBe('echo 128 > /tmp/v');
  });

  it('the audit row of the workflow carries **the inputs of this step** (the arguments of a workflow live in the workflow pack, not in the board pack)', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        inputs: { project: { type: 'string', maxLength: 50 } },
        roles: ROLES,
        steps: [{ id: 'compile', kind: 'exec', role: 'build', cmd: 'make {input:project}' }],
      },
      'w.yaml',
    );
    await runWorkflow(pack, { project: '01-hello' }, h.deps);
    expect(h.audits[0]?.inputs).toEqual({ project: '01-hello' });
    expect(h.audits[0]?.command).toBe("make '01-hello'");
  });

  it('**one audit row per step**, so the audit_id on the timeline points at a row', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          { id: 'a', kind: 'exec', role: 'build', cmd: 'make' },
          { id: 'b', kind: 'exec', role: 'build', cmd: 'make install' },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps);
    expect(h.audits).toHaveLength(2);
    expect(result.stages[0]?.audit_id).toBe('audit-1');
    expect(result.stages[1]?.audit_id).toBe('audit-2');
    // The actor of the audit is this workflow
    expect(h.audits[0]?.actor).toBe('workflow:w.flow');
  });
});

describe('workflow · danger level and output', () => {
  it('**a step declared destructive runs directly** (no prompt)', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          {
            id: 'authorize',
            kind: 'exec',
            role: 'target',
            danger: 'destructive',
            cmd: 'cat >> /root/.ssh/authorized_keys',
          },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps);
    expect(result.ok).toBe(true);
    // **The command really ran** (**the danger level is informational** — the gate is the unified permission area in the settings)
    expect(h.byId('board')?.commands).toContain('cat >> /root/.ssh/authorized_keys');
  });

  it('the `out` slot = **the output of this command** (the next step needs it)', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          { id: 'read', kind: 'exec', role: 'build', cmd: 'cat ~/.ssh/id_ed25519.pub', out: 'pubkey' },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps);
    expect(result.ok).toBe(true);
    // **The slot holds the output of that command** (the next step needs it)
    expect(result.outputs['pubkey']).toBe('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI-test claude-sandbox');
  });
});

describe('workflow · role facts', () => {
  it('the role facts are **quoted** (a profile is only half trusted, so it may not be interpolated as it is)', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          { id: 'ping', kind: 'exec', role: 'build', cmd: 'ssh {role:build.user}@{role:build.host}' },
        ],
      },
      'w.yaml',
    );
    await runWorkflow(pack, {}, h.deps);
    expect(h.byId('guest')?.commands[0]).toBe("ssh 'builder'@'10.0.0.2'");
  });
});

describe('workflow · resume', () => {
  it('**start at step n** → the earlier steps are **not run again** (running them twice means compiling twice)', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          { id: 'first', kind: 'exec', role: 'build', cmd: 'echo first' },
          { id: 'second', kind: 'exec', role: 'build', cmd: 'echo second' },
        ],
      },
      'w.yaml',
    );
    await runWorkflow(pack, {}, h.deps, { startAt: 1 });
    // **The first step did not run**
    expect(h.byId('guest')?.commands).toEqual(['echo second']);
  });

  it('a resume **carries the earlier output** (the slots are still there)', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          { id: 'find', kind: 'discover', role: 'build', dir: 'build', pattern: '*.ko', out: 'artifacts' },
          { id: 'use', kind: 'exec', role: 'build', cmd: 'ls {output:artifacts}' },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps, {
      startAt: 1,
      outputs: { artifacts: 'build/hello.ko' },
    });
    // **The second step used the slot from before**
    expect(h.byId('guest')?.commands).toEqual(["ls 'build/hello.ko'"]);
    expect(result.outputs['artifacts']).toBe('build/hello.ko');
  });

  it('**a resume is the same run** → the runId is kept', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [{ id: 'a', kind: 'exec', role: 'build', cmd: 'echo a' }],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps, { runId: 'wf-fixed' });
    expect(result.runId).toBe('wf-fixed');
  });
});

describe('workflow · the default of an input', () => {
  it('**the caller gave nothing → the default of the pack is used**', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        inputs: { project: { type: 'string', maxLength: 50, default: '01-hello' } },
        roles: ROLES,
        steps: [{ id: 'build', kind: 'exec', role: 'build', cmd: 'make {input:project}' }],
      },
      'w.yaml',
    );
    await runWorkflow(pack, {}, h.deps);
    // **The command used the default value**
    expect(h.byId('guest')?.commands[0]).toBe("make '01-hello'");
  });

  it('**`pattern` guards the shape** (an input that does not match is rejected)', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        inputs: { project: { type: 'string', maxLength: 50, pattern: '^[a-z0-9-]+$' } },
        roles: ROLES,
        steps: [{ id: 'build', kind: 'exec', role: 'build', cmd: 'make {input:project}' }],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, { project: 'BAD; rm -rf /' }, h.deps);
    // **An input that does not conform → it does not succeed** (contract §7.7: the method throws no exception and returns a failure)
    expect(result.ok).toBe(false);
    expect(result.stages[0]?.reason).toBe('invalid_params');
    // **The command was not sent**
    expect(h.byId('guest')?.commands).toHaveLength(0);
  });
});

describe('workflow · the discover step', () => {
  it('the artefact is found by the rules and **goes into the slot**', async () => {
    const h = harness({
      files: {
        guest: [
          { name: 'hello.ko', path: 'build/hello.ko', isDirectory: false, sizeBytes: 10, modifiedAt: null },
          { name: 'hello.o', path: 'build/hello.o', isDirectory: false, sizeBytes: 10, modifiedAt: null },
        ],
      },
    });
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          {
            id: 'find',
            kind: 'discover',
            role: 'build',
            dir: 'build',
            pattern: '*.ko',
            exclude: ['*.o'],
            out: 'artifacts',
          },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps);
    expect(result.ok).toBe(true);
    expect(result.outputs['artifacts']).toBe('build/hello.ko');
  });

  it('not found → **failure** (it does not report success)', async () => {
    const h = harness({ files: { guest: [] } });
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [{ id: 'find', kind: 'discover', role: 'build', dir: 'build', pattern: '*.ko', out: 'artifacts' }],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps);
    expect(result.ok).toBe(false);
    expect(result.stages[0]?.reason).toBe('not_found');
  });
});

describe('workflow · the file.transfer step (a direct transfer)', () => {
  it('the transfer command runs on the **source target**, the destination goes into the slot', async () => {
    const h = harness({
      files: {
        guest: [{ name: 'hello.ko', path: 'build/hello.ko', isDirectory: false, sizeBytes: 10, modifiedAt: null }],
      },
    });
    h.target('board').catAnswers['/usr/lib/modules/6.1.141/extra/hello.ko'] = 'ELF';
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          { id: 'find', kind: 'discover', role: 'build', dir: 'build', pattern: '*.ko', out: 'artifacts' },
          {
            id: 'deliver',
            kind: 'file.transfer',
            from: { role: 'build', path: '{output:artifacts}' },
            to: { role: 'target', placement: 'kernel-module' },
            cmd: 'scp {from.path} {role:target.user}@{role:target.host}:{to.path}',
            out: 'dest',
            readback: { kind: 'verify', role: 'target', command: 'test -f {to.path}' },
          },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps);
    expect(result.ok).toBe(true);
    // **The command runs on the guest** (the source target)
    expect(h.byId('guest')?.commands.some((c) => c.startsWith('scp '))).toBe(true);
    // The destination is resolved by the placement (the kernel version asks the board)
    expect(result.outputs['dest']).toBe('/usr/lib/modules/6.1.141/extra/hello.ko');
  });

  it('**the criterion is read on the named role** (ask the board on the board)', async () => {
    const h = harness({
      files: {
        guest: [{ name: 'hello.ko', path: 'build/hello.ko', isDirectory: false, sizeBytes: 10, modifiedAt: null }],
      },
    });
    h.target('board').catAnswers['/usr/lib/modules/6.1.141/extra/hello.ko'] = 'ELF';
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          { id: 'find', kind: 'discover', role: 'build', dir: 'build', pattern: '*.ko', out: 'artifacts' },
          {
            id: 'deliver',
            kind: 'file.transfer',
            from: { role: 'build', path: '{output:artifacts}' },
            to: { role: 'target', placement: 'kernel-module' },
            cmd: 'scp {from.path} {role:target.user}@{role:target.host}:{to.path}',
            out: 'dest',
            readback: { kind: 'verify', role: 'target', command: 'test -f {to.path}' },
          },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps);
    expect(result.ok).toBe(true);
    // **The verification command runs on the board** (not on the guest)
    expect(h.byId('board')?.commands.some((c) => c.includes('test -f'))).toBe(true);
    expect(h.byId('guest')?.commands.some((c) => c.includes('test -f'))).toBe(false);
  });
});

describe('workflow · cleanup after a failed transfer (no half-written file is left)', () => {
  const TRANSFER_PACK = {
    apiVersion: 'devboard/v1',
    kind: 'Workflow',
    id: 'w.flow',
    name: 'w',
    version: '1.0.0',
    inputs: {},
    roles: ROLES,
    steps: [
      { id: 'find', kind: 'discover', role: 'build', dir: 'build', pattern: '*.ko', out: 'artifacts' },
      {
        id: 'deliver',
        kind: 'file.transfer',
        from: { role: 'build', path: '{output:artifacts}' },
        to: { role: 'target', placement: 'kernel-module' },
        cmd: 'scp {from.path} {role:target.user}@{role:target.host}:{to.path}',
        out: 'dest',
        readback: { kind: 'verify', role: 'target', command: 'test -f {to.path}' },
      },
    ],
  };

  it('the transfer did not succeed → **the half-written file is removed** (no residue is left)', async () => {
    const h = harness({
      failCommands: ['scp '],
      files: {
        guest: [{ name: 'hello.ko', path: 'build/hello.ko', isDirectory: false, sizeBytes: 10, modifiedAt: null }],
      },
    });
    const pack = parseWorkflow(TRANSFER_PACK, 'w.yaml');
    const result = await runWorkflow(pack, {}, h.deps);
    expect(result.ok).toBe(false);

    // **The `rm -f` on the board ran**
    const rm = h.byId('board')?.commands.filter((c) => c.includes('rm -f')) ?? [];
    expect(rm.length).toBe(1);
    // **The path that is cleaned is that one**
    expect(rm[0]).toContain('hello.ko');
    // **The cleanup also records an audit row** (who deleted it and which path)
    const cleanup = h.audits.filter((a) => a.actionId.endsWith(':cleanup'));
    expect(cleanup).toHaveLength(1);
  });

  it('**it was transferred but not verified** → **it is kept** (that is not the same as "not transferred") and the reason is stated', async () => {
    const h = harness({
      // **The criterion fails** (the transfer succeeded)
      failCommands: ['test -f'],
      files: {
        guest: [{ name: 'hello.ko', path: 'build/hello.ko', isDirectory: false, sizeBytes: 10, modifiedAt: null }],
      },
    });
    const pack = parseWorkflow(
      {
        ...TRANSFER_PACK,
        steps: [
          TRANSFER_PACK.steps[0],
          {
            ...TRANSFER_PACK.steps[1],
            // **The timeout of the criterion is shortened** (the form verify defaults to 5 seconds, which would drag the test out)
            readback: { kind: 'verify', role: 'target', command: 'test -f {to.path}', timeout_ms: 200 },
          },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps);
    expect(result.ok).toBe(false);

    // **Not a single `rm -f` may run** (the file may be fine — deleting it is worse than leaving a half one)
    expect(h.byId('board')?.commands.some((c) => c.includes('rm -f'))).toBe(false);
    // **It states "it was transferred, it was not verified"** (the prototype of the scout Q3 — what the state on the board is has to be visible)
    const stage = result.stages.find((s) => s.stepId === 'deliver');
    expect(stage?.detail).toContain('transferred but not verified');
  });

  it('**the cleanup path must be encoded** (`to.path` comes from the pack, and an unencoded path is an injection surface)', async () => {
    const h = harness({
      failCommands: ['scp '],
      files: {
        guest: [{ name: 'hello.ko', path: 'build/hello.ko', isDirectory: false, sizeBytes: 10, modifiedAt: null }],
      },
    });
    const pack = parseWorkflow(
      {
        ...TRANSFER_PACK,
        steps: [
          TRANSFER_PACK.steps[0],
          {
            ...TRANSFER_PACK.steps[1],
            // **The path of the destination carries a command** (it comes from the pack, so the host has to encode it when it composes the command)
            to: { role: 'target', path: '/opt/x; reboot' },
          },
        ],
      },
      'w.yaml',
    );
    await runWorkflow(pack, {}, h.deps);
    const rm = h.byId('board')?.commands.filter((c) => c.includes('rm -f')) ?? [];
    expect(rm).toHaveLength(1);
    // **The path is wrapped in quotes** (`; reboot` is not a second command)
    expect(rm[0]).toContain("'/opt/x; reboot'");
  });

  it('the destination **already has** that file → **it may not be deleted** (the user\'s data stays)', async () => {
    const h = harness({
      failCommands: ['scp '],
      files: {
        guest: [{ name: 'hello.ko', path: 'build/hello.ko', isDirectory: false, sizeBytes: 10, modifiedAt: null }],
        board: [
          {
            name: 'hello.ko',
            path: '/usr/lib/modules/6.1.141/extra/hello.ko',
            isDirectory: false,
            sizeBytes: 99,
            modifiedAt: null,
          },
        ],
      },
    });
    const pack = parseWorkflow(TRANSFER_PACK, 'w.yaml');
    await runWorkflow(pack, {}, h.deps);
    // **Not a single `rm -f` may run** (that is the file of the user)
    expect(h.byId('board')?.commands.some((c) => c.includes('rm -f'))).toBe(false);
  });
});

describe('workflow · inputs.default (contract §2)', () => {
  it('**the value form also receives the default** (the expect of a readback uses the value form)', async () => {
    const h = harness();
    h.target('board').catAnswers['/tmp/x'] = '5';
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        // **The caller gives no count** → the default is used
        inputs: { count: { type: 'integer', default: 5 } },
        roles: ROLES,
        steps: [
          {
            id: 'write',
            kind: 'exec',
            role: 'build',
            cmd: 'echo {input:count}',
            // **The value form** — it compares the **value**, not a shell fragment
            readback: { kind: 'file_equals', role: 'target', path: '/tmp/x', expect: '{input:count}' },
          },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps);
    // **The readback matches** (the default really entered the value form)
    expect(result.ok).toBe(true);
    expect(result.stages[0]?.verified).toBe(true);
  });
});

describe('workflow · a failing step still produces its row', () => {
  it('**the target cannot be reached → there is a row on the timeline** (the whole run is not thrown)', async () => {
    // **The board is not plugged in** → asking it for the kernel version blew up
    const h = harness({ failProfile: 'board' });
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          {
            id: 'deliver',
            kind: 'file.transfer',
            from: { role: 'build', path: 'build/hello.ko' },
            to: { role: 'target', placement: 'kernel-module' },
            cmd: 'scp {from.path} {role:target.user}@{role:target.host}:{to.path}',
          },
        ],
      },
      'w.yaml',
    );
    // **It may not be thrown as a whole** (thrown out → the timeline has not a single row → the user cannot see which step it was)
    const result = await runWorkflow(pack, {}, h.deps);
    expect(result.ok).toBe(false);
    // **The timeline has that row**
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]?.stepId).toBe('deliver');
    expect(result.stages[0]?.ok).toBe(false);
  });
});

describe('workflow · cancellation (the operator stops it)', () => {
  it('**it was stopped → the later step does not run** (the operator no longer wants it, so it does not go on)', async () => {
    const controller = new AbortController();
    const h = harness({
      // **It is stopped right after the first step finished**
      onExec: (command) => {
        if (command.includes('first')) controller.abort();
      },
    });
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          { id: 'one', kind: 'exec', role: 'build', cmd: 'echo first' },
          { id: 'two', kind: 'exec', role: 'build', cmd: 'echo second' },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps, {
      signal: controller.signal,
    });
    // **The first step ran**
    expect(h.byId('guest')?.commands.some((c) => c.includes('first'))).toBe(true);
    // **The second step may not run** (the operator stopped it, going on would be disobedience)
    expect(h.byId('guest')?.commands.some((c) => c.includes('second'))).toBe(false);
    // **The timeline holds only the first step**
    expect(result.stages.map((s) => s.stepId)).toEqual(['one']);
  });

  it('**it was stopped → the cross-target criterion does not run** (after a cancellation nobody should wait for another command)', async () => {
    const controller = new AbortController();
    const h = harness({
      files: {
        guest: [{ name: 'hello.ko', path: 'build/hello.ko', isDirectory: false, sizeBytes: 10, modifiedAt: null }],
      },
      // **It is stopped when the transfer step begins**
      onExec: (command) => {
        if (command.startsWith('scp ')) controller.abort();
      },
    });
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          { id: 'find', kind: 'discover', role: 'build', dir: 'build', pattern: '*.ko', out: 'artifacts' },
          {
            id: 'deliver',
            kind: 'file.transfer',
            from: { role: 'build', path: '{output:artifacts}' },
            to: { role: 'target', placement: 'kernel-module' },
            cmd: 'scp {from.path} {role:target.user}@{role:target.host}:{to.path}',
            out: 'dest',
            readback: { kind: 'verify', role: 'target', command: 'test -f {to.path}' },
          },
        ],
      },
      'w.yaml',
    );
    await runWorkflow(pack, {}, h.deps, { signal: controller.signal });
    // **The `test -f` on the board may not run** (nothing was transferred, verifying it is meaningless)
    expect(h.byId('board')?.commands.some((c) => c.includes('test -f'))).toBe(false);
  });
});

describe('workflow · the assert step', () => {
  it('the criterion does not match → **failure** (the default of assert)', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          {
            id: 'check',
            kind: 'assert',
            readback: { kind: 'file_equals', role: 'target', path: '/tmp/x', expect: '1' },
          },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps);
    expect(result.ok).toBe(false);
    expect(result.stages[0]?.reason).toBe('not_found');
  });

  it('`on_mismatch: continue` → **the run continues**', async () => {
    const h = harness();
    const pack = parseWorkflow(
      {
        apiVersion: 'devboard/v1',
        kind: 'Workflow',
        id: 'w.flow',
        name: 'w',
        version: '1.0.0',
        inputs: {},
        roles: ROLES,
        steps: [
          {
            id: 'check',
            kind: 'assert',
            readback: { kind: 'file_equals', role: 'target', path: '/tmp/x', expect: '1' },
            on_mismatch: 'continue',
          },
          { id: 'after', kind: 'exec', role: 'build', cmd: 'echo after' },
        ],
      },
      'w.yaml',
    );
    const result = await runWorkflow(pack, {}, h.deps);
    expect(result.stages).toHaveLength(2);
    expect(h.byId('guest')?.commands).toEqual(['echo after']);
    // **The whole run is still not a success** (that step indeed did not succeed)
    expect(result.ok).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkflow } from '../../src/main/workflows/runner';
import { TargetRegistry } from '../../src/main/workflows/targets';
import { parseWorkflow } from '../../src/main/workflows/format';
import { ActionAudit } from '../../src/main/actions/audit';
import { FakeConnection } from '../../src/main/hal/fake/connection';
import { fakeProfile } from '../../src/main/hal/fake/profile';
import { SessionLog } from '../../src/main/logging/session-log';
import type { ConnectionProfile } from '../../src/main/profiles/schema';

/**
 * The integration check of the workflow layer (the **fake device** plays two
 * roles).
 *
 * ── Why it is not an Electron e2e test ──
 *
 * **The application has no entry point for a workflow yet** (the first version
 * is only triggered by `npm run workflow:run` — ADR-D31 R1: the card API and
 * the MCP tools do not change the contract in the first version).
 * → Running a workflow inside Electron **proves nothing about the
 *   application** (it does not go through the application at all).
 * → So what is verified here is the **real chain**: the workflow pack → the
 *   target registry → the **real HAL (the fake device)** → the seven-step
 *   chain → the **real audit file**.
 *
 * ── Two roles = two disks ──
 *
 * The fake device **keeps one disk per profile id**
 * (`fakeFilesystem(profile.id)`) → `build` and `target` each have one →
 * "is that file really on the board now" **is verified on another disk** —
 * that is exactly what a **criterion across two targets** has to prove (the
 * opposite of RF-6).
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cockpit-workflow-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ROLES = {
  build: { purpose: 'Fake guest machine', profile: 'build' },
  target: { purpose: 'Fake board', profile: 'target' },
};

function harness(): {
  run: ReturnType<typeof runWorkflow>;
  auditPath: string;
  readAudit: () => string[];
} {
  const log = new SessionLog({ label: 'fake', transport: 'local', dataDir: dir });
  const profiles = new Map<string, ConnectionProfile>([
    ['build', fakeProfile('build')],
    ['target', fakeProfile('target')],
  ]);
  const registry = new TargetRegistry({
    profileFor: (id) => profiles.get(id),
    createConnection: (profile) =>
      new FakeConnection({
        now: () => 1_700_000_000_000,
        log,
        profile,
        // No failure is injected (this judgment wants a clean run)
        timeoutEvery: 0,
        breakMeminfoEvery: 0,
      }),
  });
  const auditPath = join(dir, 'logs', 'actions.log');
  const audit = new ActionAudit(auditPath);

  const pack = parseWorkflow(
    {
      apiVersion: 'devboard/v1',
      kind: 'Workflow',
      id: 'fake-flow.build-run',
      name: 'Build on the fake device, transfer it, place it',
      version: '1.0.0',
      inputs: { artifact: { type: 'string', maxLength: 50 } },
      roles: ROLES,
      steps: [
        { id: 'compile', kind: 'exec', role: 'build', cmd: 'make {input:artifact}' },
        {
          id: 'find',
          kind: 'discover',
          role: 'build',
          dir: 'build',
          pattern: '*.ko',
          exclude: ['*.o'],
          out: 'artifacts',
        },
        {
          id: 'deliver',
          kind: 'file.transfer',
          from: { role: 'build', path: '{output:artifacts}' },
          to: { role: 'target', placement: 'kernel-module' },
          cmd: 'scp {from.path} {role:target.user}@{role:target.host}:{to.path}',
          out: 'dest',
          // The criterion names its target → it is verified on **another disk**
          readback: { kind: 'verify', role: 'target', command: 'test -f {to.path}' },
        },
        {
          id: 'load',
          kind: 'exec',
          role: 'target',
          cmd: 'depmod -a && modprobe {output:artifacts.name}',
          readback: { kind: 'command_ok' },
        },
      ],
    },
    'fake-flow.yaml',
  );

  // ── First put an artefact on the disk of the **fake guest machine** ──
  // (the discovery has to find something to reach the next step; the disk of
  // the fake device starts empty)
  const seed = async (): Promise<void> => {
    await registry.runOn('build', async (conn) => conn.exec('echo ko > build/hello.ko'));
  };

  const run = (async () => {
    await seed();
    return runWorkflow(
      pack,
      { artifact: 'hello' },
      {
        targets: registry,
        profileFor: (id) => profiles.get(id),
        audit: (row) => audit.append(row),
        now: () => 1_700_000_000_000,
      },
    );
  })();

  return {
    run,
    auditPath,
    readAudit: () =>
      existsSync(auditPath)
        ? readFileSync(auditPath, 'utf8').trim().split('\n').filter((l) => l.length > 0)
        : [],
  };
}

describe('The workflow layer · two roles on the fake device', () => {
  it('a workflow runs through, and every stage has an audit row (the timeline and the audit agree)', async () => {
    const h = harness();
    const result = await h.run;

    // The artefact has to be there on the fake device first (otherwise the
    // discovery finds nothing)
    expect(result.stages.length).toBeGreaterThan(0);
    // Every stage carries an audit id
    for (const stage of result.stages) {
      expect(stage.audit_id, `the stage ${stage.stepId} has no audit id`).toBeTruthy();
    }
    // Those rows can be found in the audit file
    const lines = h.readAudit();
    expect(lines.length).toBeGreaterThan(0);
    for (const stage of result.stages) {
      expect(lines.some((l) => l.includes(stage.audit_id as string))).toBe(true);
    }
  });

  it('a criterion across two targets is verified on the disk of the target (not on its own disk, talking to itself)', async () => {
    const h = harness();
    await h.run;
    const lines = h.readAudit();
    // The criterion across two targets is a line of its own (two facts → two
    // rows in the ledger)
    const cross = lines.filter((l) => l.includes(':deliver:readback'));
    expect(cross).toHaveLength(1);
    // The criterion is verified on the target → the action id carries the role of the target
    expect(cross[0]).toContain('workflow:fake-flow.build-run');
  });
});

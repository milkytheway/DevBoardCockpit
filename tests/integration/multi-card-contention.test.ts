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
 * Two cards contend for the same board (the scheduling of the runtime with
 * several cards).
 *
 * ── Why this one exists ──
 *
 * The cards do **not** hold a connection each — every action goes through
 * **the one connection of the runtime and the one queue**
 * (`actionsFor` in `main/index.ts` → `runtime.runTransaction`).
 * → So two cards that touch the same board at the same time **do not talk
 *   over each other** (on a serial line that matters most — fact S1).
 *
 * → But that property **had no judgment** → the day somebody gives each card
 *   a connection of its own, the "pressed a button, the numbers on the
 *   monitoring card jump around" symptom comes back on a serial line (the
 *   symptom the contract names in `docs/spec/02-board-pack.md` section 1.2.1).
 *
 * ── What it watches ──
 *
 * → **Only one round trip is in flight at a time** (not "the two cards do not
 *   interleave" — that is a property of a single connection).
 */

/** A board pack that starts (the runtime really needs a pack to come up) */
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
  label: 'Board',
  transport: 'adb',
  board_pack: 'tiny',
  options: {},
};

const ACTION: ActionDef = {
  id: 'act.set',
  label: 'Set',
  danger: 'reversible',
  params: { value: { type: 'integer', min: 0, max: 255 } },
  command: 'echo {value}',
  readback: { kind: 'none', consequence: 'there is no state that can be read back' },
};

describe('Two cards · the same board', () => {
  it('actions called at the same time do not interleave their round trips (one queue — no talking over each other on a serial line)', async () => {
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
      // The actions of both cards go through the one connection of the
      // runtime (the same shape as in main/index.ts)
      actionsFor: () => ({
        invoke: (id: string, params: Record<string, unknown>) =>
          invokeAction(
            { ...ACTION, id },
            params,
            {
              packId: 'tiny',
              contractVersion: 'devboard/v1',
              // The board in use: the credentials are bound to it (contract
              // `docs/spec/04-mcp-tools.md` section 2.4.1, the sixth item)
              deviceKey: () => 'tiny-board',
              hasExitCode: true,
              runTransaction: (fn) => runtime.runTransaction(fn),
              readTag: async () => undefined,
              granted: () => ({ actions: { [ACTION.id]: undefined } }),
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

    // Only one round trip is in flight at a time
    expect(maxInFlight).toBe(1);
    runtime.stop();
    rmSync(packsDir, { recursive: true, force: true });
  });
});

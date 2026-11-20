import { describe, it, expect } from 'vitest';
import { buildMcpHost } from '../../../src/main/mcp/wiring';
import type { TagRuntime } from '../../../src/main/tags/runtime';
import type { TerminalManager } from '../../../src/main/terminal/manager';
import type { CardRegistry } from '../../../src/main/cards/registry';
import type { CardRuntimeLog } from '../../../src/main/cards/runtime-log';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';
import type { RuntimeStatus } from '../../../src/shared/runtime-status';

/**
 * The wiring the host assembles.
 *
 * What these criteria guard:
 *
 * | Criterion | Why |
 * |---|---|
 * | **the runtime cannot be reached → `connected` is `false`** | "it has a profileId" is not "connected" |
 * | **the runtime stopped → `connected` is `false`** | the same |
 * | **a terminal session is open → `connected` is `true`** | that is a live connection as well |
 * | **`sample_tag` has to sample first** | without a sample the agent gets a **frozen old sample** (contract §2.1) |
 */

const PROFILE: ConnectionProfile = {
  id: 'board',
  label: 'the board',
  transport: 'adb',
  board_pack: 'demo-pack',
  options: {},
};

/** A fake runtime (**only the parts the wiring needs**) */
function runtime(status: RuntimeStatus, sampled: string[] = []): TagRuntime {
  return {
    get status(): RuntimeStatus {
      return status;
    },
    get packView() {
      return {
        id: 'demo-pack',
        name: 'demo pack',
        version: '1.0.0',
        poll_groups: [],
        readers: [],
        actions: [],
      };
    },
    readings: () => [],
    sampleHistory: () => [],
    sampleTag: async (tag: string) => {
      sampled.push(tag);
      return undefined;
    },
  } as unknown as TagRuntime;
}

function terminal(live: string[]): TerminalManager {
  return { liveProfileIds: () => live } as unknown as TerminalManager;
}

function wiring(over: {
  status: RuntimeStatus;
  live?: string[];
  sampled?: string[];
}): {
  listProfiles: () => ConnectionProfile[];
  runtime: TagRuntime;
  terminal: TerminalManager;
  cards: CardRegistry;
  cardLog: CardRuntimeLog;
  layoutGet: () => never;
  layoutSet: () => void;
  agentActions: never;
} {
  return {
    listProfiles: () => [PROFILE],
    runtime: runtime(over.status, over.sampled ?? []),
    terminal: terminal(over.live ?? []),
    cards: { cards: () => [], dirOf: () => null } as unknown as CardRegistry,
    cardLog: { read: () => [] } as unknown as CardRuntimeLog,
    layoutGet: () => undefined as never,
    layoutSet: () => undefined,
    agentActions: undefined as never,
  };
}

describe('MCP wiring · the criterion for connected', () => {
  it('**the runtime is `running` and it is this profile → connected**', () => {
    const host = buildMcpHost(
      wiring({ status: { state: 'running', profileId: 'board' } }),
    );
    expect(host.connected('board')).toBe(true);
  });

  it('**the runtime cannot be reached (`error`) → it may not report "connected"** ("it has a profileId" is not "connected")', () => {
    // **the `profileId` still has a value** (it is not cleared when the runtime
// cannot be reached) — but it is **not connected**
    const host = buildMcpHost(
      wiring({ status: { state: 'error', profileId: 'board', detail: 'cannot be reached' } }),
    );
    expect(host.connected('board')).toBe(false);
  });

  it('**the runtime stopped (`idle`) → it may not report "connected"**', () => {
    const host = buildMcpHost(
      wiring({ status: { state: 'idle', profileId: 'board' } }),
    );
    expect(host.connected('board')).toBe(false);
  });

  it('**a terminal session is open → connected** (that is a live connection as well)', () => {
    const host = buildMcpHost(
      wiring({ status: { state: 'idle' }, live: ['board'] }),
    );
    expect(host.connected('board')).toBe(true);
  });

  it('**another profile → not connected**', () => {
    const host = buildMcpHost(
      wiring({ status: { state: 'running', profileId: 'other' } }),
    );
    expect(host.connected('board')).toBe(false);
  });
});

describe('MCP wiring · sample_tag has to sample first', () => {
  it('**it has been sampled** (without a sample the agent gets a **frozen old sample**)', async () => {
    const sampled: string[] = [];
    const host = buildMcpHost(
      wiring({ status: { state: 'running', profileId: 'board' }, sampled }),
    );
    await host.refreshTag('cpu.usage');
    expect(sampled).toEqual(['cpu.usage']);
  });

  it('**it does not crash when the sample fails** (there is no such tag, so there is no such tag)', async () => {
    const host = buildMcpHost(wiring({ status: { state: 'error' } }));
    await expect(host.refreshTag('nope.nope')).resolves.toBeUndefined();
  });
});

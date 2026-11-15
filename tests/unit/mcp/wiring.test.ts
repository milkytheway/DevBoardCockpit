import { describe, it, expect } from 'vitest';
import { buildMcpHost } from '../../../src/main/mcp/wiring';
import type { TagRuntime } from '../../../src/main/tags/runtime';
import type { TerminalManager } from '../../../src/main/terminal/manager';
import type { CardRegistry } from '../../../src/main/cards/registry';
import type { CardRuntimeLog } from '../../../src/main/cards/runtime-log';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';
import type { RuntimeStatus } from '../../../src/shared/runtime-status';

/**
 * **宿主拼装的接线**（`docs/04` §9.2.1 ✓ · ADR-D40 ✓）。
 *
 * ── 这组判据守什么 ──
 *
 * | 判据 | 为什么 |
 * |---|---|
 * | **运行时连不上 → `connected` 是 `false`** ✓ | **「有 profileId」≠「连着」** ✓（评审 I-1 ✓） |
 * | **运行时停下 → `connected` 是 `false`** ✓ | 同上 ✓ |
 * | **开着终端会话 → `connected` 是 `true`** ✓ | 那条也是活连接 ✓ |
 * | **`sample_tag` 要先采一次** ✓ | 不采的话 agent 拿到**冻结的旧样本** ✓（契约 §2.1 ✓） |
 */

const PROFILE: ConnectionProfile = {
  id: 'board',
  label: '板子',
  transport: 'adb',
  board_pack: 'demo-pack',
  options: {},
};

/** 假运行时（**只给接线要的那几个** ✓） */
function runtime(status: RuntimeStatus, sampled: string[] = []): TagRuntime {
  return {
    get status(): RuntimeStatus {
      return status;
    },
    get packView() {
      return {
        id: 'demo-pack',
        name: '演示包',
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

describe('MCP 接线的 · connected 的判据', () => {
  it('**运行时是 `running` 且就是这条 profile → 连着** ✓', () => {
    const host = buildMcpHost(
      wiring({ status: { state: 'running', profileId: 'board' } }),
    );
    expect(host.connected('board')).toBe(true);
  });

  it('**运行时连不上（`error`）→ 不许报「连着」** ✓（**「有 profileId」≠「连着」** ✓）', () => {
    // **`profileId` 仍然有值** ✓（运行时连不上时它不清 ✓）—— 但**没连着** ✓
    const host = buildMcpHost(
      wiring({ status: { state: 'error', profileId: 'board', detail: '连不上' } }),
    );
    expect(host.connected('board')).toBe(false);
  });

  it('**运行时停下了（`idle`）→ 不许报「连着」** ✓', () => {
    const host = buildMcpHost(
      wiring({ status: { state: 'idle', profileId: 'board' } }),
    );
    expect(host.connected('board')).toBe(false);
  });

  it('**开着终端会话 → 连着** ✓（那也是活连接 ✓）', () => {
    const host = buildMcpHost(
      wiring({ status: { state: 'idle' }, live: ['board'] }),
    );
    expect(host.connected('board')).toBe(true);
  });

  it('**别的 profile → 不连着** ✓', () => {
    const host = buildMcpHost(
      wiring({ status: { state: 'running', profileId: 'other' } }),
    );
    expect(host.connected('board')).toBe(false);
  });
});

describe('MCP 接线的 · sample_tag 要先采一次', () => {
  it('**采过了** ✓（**不采的话拿到的是冻结的旧样本** ✓）', async () => {
    const sampled: string[] = [];
    const host = buildMcpHost(
      wiring({ status: { state: 'running', profileId: 'board' }, sampled }),
    );
    await host.refreshTag('cpu.usage');
    expect(sampled).toEqual(['cpu.usage']);
  });

  it('**采不到也不炸** ✓（**没这个 tag 就是没这个 tag** ✓）', async () => {
    const host = buildMcpHost(wiring({ status: { state: 'error' } }));
    await expect(host.refreshTag('nope.nope')).resolves.toBeUndefined();
  });
});

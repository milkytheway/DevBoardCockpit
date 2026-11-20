import { describe, it, expect, vi } from 'vitest';

/**
 * The IPC channel of the tag readings.
 *
 * Why these two channels are "criteria" and not only "implementation":
 *
 * The migration of the five states of contract §2.1 is **stateful** (ADR-D22):
 * "the readings only enter through the TagStore and only leave through the
 * TagStore". Therefore the renderer side can **only** get two things:
 * 1. the **current snapshot** (`tags:readings`) — a late subscriber does
 *    **not** lose the current value;
 * 2. the **pushes of a change** (`tags:changed`) — the values move by
 *    themselves.
 *
 * **Only pushing loses the late subscribers; only pulling means the values do
 * not move.** Both are needed — that is why they are criteria.
 */

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  exposed: {} as Record<string, unknown>,
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: unknown): void => {
      mocks.exposed = api as Record<string, unknown>;
    },
  },
  ipcRenderer: {
    invoke: mocks.invoke,
    send: mocks.send,
    on: mocks.on,
    off: mocks.off,
  },
  webUtils: {
    getPathForFile: (file: File): string => `C:\\Users\\me\\${file.name}`,
  },
}));

import { IPC } from '../../src/shared/ipc-contract';
import { api } from '../../src/preload/index';

describe('the IPC channel of the tag readings', () => {
  it('a misspelled name of the channel has to be **red at compile time** — that is what the table of the IPC is for', () => {
    expect(IPC.tagsReadings).toBe('tags:readings');
    expect(IPC.tagsChanged).toBe('tags:changed');
  });

  it('the preload offers the two methods "take a snapshot" and "listen for changes"', () => {
    expect(typeof api.tagsReadings).toBe('function');
    expect(typeof api.onTagChanged).toBe('function');
  });

  it('taking a snapshot goes through invoke and gives the result of the main process', async () => {
    const snapshot = [
      { tag: 'cpu.usage', value: 12.5, unit: 'percent', status: 'ok', at: 1, seq: 1 },
    ];
    mocks.invoke.mockResolvedValue({ ok: true, value: snapshot });

    await expect(api.tagsReadings()).resolves.toEqual(snapshot);
    expect(mocks.invoke).toHaveBeenCalledWith('tags:readings');
  });

  it('listening for changes: the subscriber gets the pushes, and **after the unsubscription it does not get them any more**', () => {
    const seen: unknown[] = [];
    const off = api.onTagChanged((reading) => seen.push(reading));

    expect(mocks.on).toHaveBeenCalledWith('tags:changed', expect.any(Function));

    // It simulates one push of the main process
    const handler = mocks.on.mock.calls[0]?.[1] as (e: unknown, r: unknown) => void;
    const reading = { tag: 'cpu.usage', value: 1, unit: 'percent', status: 'ok', at: 1, seq: 2 };
    handler({}, reading);
    expect(seen).toEqual([reading]);

    off();
    expect(mocks.off).toHaveBeenCalledWith('tags:changed', expect.any(Function));
  });
});

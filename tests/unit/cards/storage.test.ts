import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStorage, KEY_LIMIT_BYTES, NAMESPACE_LIMIT_BYTES } from '../../../src/main/cards/storage';

/**
 * The storage of a card (contract §6.2).
 *
 * Three hard constraints:
 *
 * 1. **One namespace per card** — the cards cannot see each other.
 * 2. **There is a quota** — 64 KB per key, 1 MB per namespace. A card is
 *    written by an AI and it may accidentally put a huge value in;
 *    **without a limit one card fills up the disk of the user**.
 * 3. **A key name may not start with `__`** — that is reserved for the host.
 */
function tempStorage(): { storage: CardStorage; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'card-store-'));
  return {
    storage: new CardStorage({ dir }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('the storage of the card', () => {
  it('what was written can be read back', () => {
    const { storage, cleanup } = tempStorage();
    try {
      expect(storage.set('cpu-usage', 'zoom', 2)).toEqual({ ok: true });
      expect(storage.get('cpu-usage', 'zoom')).toBe(2);
    } finally {
      cleanup();
    }
  });

  it('**the cards cannot see each other**', () => {
    const { storage, cleanup } = tempStorage();
    try {
      storage.set('card-a', 'k', 'A');
      expect(storage.get('card-b', 'k')).toBeUndefined();
      expect(storage.keys('card-b')).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('a single key beyond 64 KB → quota_exceeded', () => {
    const { storage, cleanup } = tempStorage();
    try {
      const big = 'x'.repeat(KEY_LIMIT_BYTES + 10);
      expect(storage.set('cpu-usage', 'big', big)).toEqual({ ok: false, reason: 'quota_exceeded' });
    } finally {
      cleanup();
    }
  });

  it('a namespace beyond 1 MB → quota_exceeded', () => {
    const { storage, cleanup } = tempStorage();
    try {
      const chunk = 'y'.repeat(KEY_LIMIT_BYTES - 100);
      for (let i = 0; i < 20; i += 1) {
        const res = storage.set('cpu-usage', `k${i}`, chunk);
        if (!res.ok) {
          expect(res.reason).toBe('quota_exceeded');
          return;
        }
      }
      throw new Error('the quota was not stopped');
    } finally {
      cleanup();
    }
  });

  it('a key name that starts with `__` → it is refused (**the reason code has to be right**: not "the value cannot be serialised")', () => {
    const { storage, cleanup } = tempStorage();
    try {
      expect(storage.set('cpu-usage', '__x', 1).ok).toBe(false);
      expect(storage.set('cpu-usage', '__x', 1).reason).toBe('reserved_key');
    } finally {
      cleanup();
    }
  });

  it('a value that cannot be serialised to JSON → it is refused (a function, a circular reference)', () => {
    const { storage, cleanup } = tempStorage();
    try {
      expect(storage.set('cpu-usage', 'fn', () => 1)).toEqual({
        ok: false,
        reason: 'not_serializable',
      });
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;
      expect(storage.set('cpu-usage', 'circ', circular).reason).toBe('not_serializable');
    } finally {
      cleanup();
    }
  });

  it('deleting a key and clearing', () => {
    const { storage, cleanup } = tempStorage();
    try {
      storage.set('cpu-usage', 'a', 1);
      storage.set('cpu-usage', 'b', 2);
      storage.remove('cpu-usage', 'a');
      expect(storage.keys('cpu-usage')).toEqual(['b']);
      storage.clear('cpu-usage');
      expect(storage.keys('cpu-usage')).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('**it is still there after a restart** (the uninstall keeps the data, contract §6.2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'card-store-'));
    try {
      const first = new CardStorage({ dir });
      first.set('cpu-usage', 'zoom', 3);
      // A new instance = after a restart
      const second = new CardStorage({ dir });
      expect(second.get('cpu-usage', 'zoom')).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the limit of a namespace is 1 MB (do not write it wrong)', () => {
    expect(NAMESPACE_LIMIT_BYTES).toBe(1024 * 1024);
    expect(KEY_LIMIT_BYTES).toBe(64 * 1024);
  });
});

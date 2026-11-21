import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCardWiring } from '../../../src/main/cards/wiring';
import type { CardPermissions } from '../../../src/main/cards/permissions';

/**
 * The **wiring** of the card host.
 *
 * Why this layer needs its own test:
 *
 * Every module can be right and the assembly still be wrong — that is not a
 * hypothesis, it is what happened in this round:
 *
 * | Symptom | Whose fault it was |
 * |---|---|
 * | the card area stayed blank | the `frame-src` of the CSP of the shell (not in the card module) |
 * | `window.cockpit` was always undefined | the injected URL missed the instance id (not in the card module) |
 * | editing a file made the card "invalid" | the list of ids that the wiring layer hands to the validator |
 *
 * → The tests of the single modules do not cover the **wiring**, so the wiring
 * needs its own test.
 */

/**
 * The "not verified" of **rule 5** (a hole that was exposed when the
 * application was installed on 2026-11-19).
 *
 * The symptom:
 *
 * After the installation `list_cards` reported: **every card that can write
 * to the board has `status: "degraded"`** — while `degraded: false`,
 * `missing_tags: []` and `unreadable_tags: []` are all empty, which
 * **contradicts itself** and makes an agent read it as "this card is broken".
 *
 * The cause:
 *
 * ① The validation route through the registry hard-codes `availableActions`
 *    to `null`, so **rule 5 always takes the "not verified" branch** and
 *    **always carries a warning**, and `status` counts a **warning** as
 *    degraded, so **the card is degraded right after the installation**.
 * ② **The card is validated at startup**, when the board is not connected
 *    yet, so even a real table cannot be obtained, and **it is not recomputed
 *    after the connection**, so the **warning stays forever**.
 *
 * The route of `validate_card` in MCP, on the other hand, is given a **real
 * table**, so **one product had two answers** — invisible during the
 * development and only exposed after the installation.
 *
 * The fix: **the route through the registry is given a real table as well**
 * and **it is scanned once more after the connection**.
 */
describe('rule 5 · "not verified" may not stay forever', () => {
  it('**the board is connected → the route through the registry does not report "not verified"** (the same wording as the validate_card of MCP)', () => {
    const fx = fixtureWithWrite();
    try {
      const wiring = createCardWiring({
        roots: [{ dir: fx.roots, kind: 'user' }],
        runtime: { readings: () => [], subscribe: () => () => undefined },
        broadcast: () => undefined,
        currentConnectionId: () => 'board-a',
        permsFor: () => ({ read: [], write: ['led.set'] }),
        // **The board pack is bound → a real table is given**
        availableActions: () => ['led.set'],
        // **The two things the wiring layer needs** (the storage directory, the layout
// file — the same as in `wiringOf`)
        storageDir: fx.storageDir,
        layoutFile: join(fx.base, 'layout.json'),
      });
      wiring.refresh();
      const card = wiring.registry.cards().find((c) => c.manifest.id === 'write-card');
      const warnings = card?.issues.filter((i) => i.severity === 'warning') ?? [];
      expect(warnings, 'with the board connected it may not say "not verified"').toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  it('**offline → it is a warning, not an error** ("not verified" is not "not valid")', () => {
    const fx = fixtureWithWrite();
    try {
      const wiring = createCardWiring({
        roots: [{ dir: fx.roots, kind: 'user' }],
        runtime: { readings: () => [], subscribe: () => () => undefined },
        broadcast: () => undefined,
        currentConnectionId: () => 'board-a',
        permsFor: () => ({ read: [], write: ['led.set'] }),
        // **Offline → null**
        availableActions: () => null,
        // **The two things the wiring layer needs** (the same as in `wiringOf`)
        storageDir: fx.storageDir,
        layoutFile: join(fx.base, 'layout.json'),
      });
      wiring.refresh();
      const card = wiring.registry.cards().find((c) => c.manifest.id === 'write-card');
      const warnings = card?.issues.filter((i) => i.severity === 'warning') ?? [];
      expect(warnings.length, 'offline it has to say "not verified"').toBeGreaterThan(0);
      const errors = card?.issues.filter((i) => i.severity === 'error') ?? [];
      expect(errors, '"not verified" is not "not valid"').toEqual([]);
    } finally {
      fx.cleanup();
    }
  });
});

interface Fixture {
  base: string;
  roots: string;
  storageDir: string;
  cleanup: () => void;
}

function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'card-wiring-'));
  const roots = join(base, 'cards');
  const storageDir = join(base, 'card-storage');
  mkdirSync(join(roots, 'cpu-usage'), { recursive: true });
  writeFileSync(
    join(roots, 'cpu-usage', 'manifest.json'),
    JSON.stringify({
      apiVersion: 'devboard/v1',
      kind: 'Card',
      id: 'cpu-usage',
      name: 'CPU usage',
      version: '1.0.0',
      description: 'shows the total CPU usage',
      entry: 'index.html',
      requires: { tags: ['cpu.usage'] },
      layout: { w: 3, h: 2, min_w: 2, min_h: 1 },
      permissions: { read: ['cpu.usage'], write: [] },
      actions: [],
    }),
    'utf8',
  );
  writeFileSync(join(roots, 'cpu-usage', 'index.html'), '<!doctype html><html></html>', 'utf8');
  return {
    base,
    roots,
    storageDir,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

const PERMS: CardPermissions = { read: ['cpu.usage'], write: [] };

/** A card **with write permissions** (rule 5 only fires for a card that has write permissions) */
function fixtureWithWrite(): Fixture {
  const fx = fixture();
  mkdirSync(join(fx.roots, 'write-card'), { recursive: true });
  writeFileSync(
    join(fx.roots, 'write-card', 'manifest.json'),
    JSON.stringify({
      apiVersion: 'devboard/v1',
      kind: 'Card',
      id: 'write-card',
      name: 'a card that writes to the board',
      version: '1.0.0',
      entry: 'index.html',
      requires: {},
      permissions: { read: [], write: ['led.set'] },
      actions: [],
    }),
    'utf8',
  );
  writeFileSync(join(fx.roots, 'write-card', 'index.html'), '<!doctype html><html></html>', 'utf8');
  return fx;
}

function wiringOf(fx: Fixture, opts: { connectionId?: () => string | null } = {}) {
  return createCardWiring({
    roots: [{ dir: fx.roots, kind: 'user' }],
    runtime: { readings: () => [], subscribe: () => () => undefined },
    broadcast: () => undefined,
    currentConnectionId: opts.connectionId ?? (() => 'board-a'),
    permsFor: () => PERMS,
    storageDir: fx.storageDir,
    layoutFile: join(fx.base, 'layout.json'),
  });
}

describe('the card wiring · rule 2 (the id is unique worldwide)', () => {
  it('**a second refresh does not judge the card itself as a duplicate**', () => {
    const fx = fixture();
    try {
      const wiring = wiringOf(fx);
      wiring.refresh();
      expect(wiring.list()[0]?.degraded).toBe(false);
      // **Once again** — "edit the file and it takes effect" is the central action,
      // and the hot reload necessarily triggers a second refresh
      wiring.refresh();
      expect(wiring.list()[0]?.degraded).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it('two cards **really** share an id → the second one has to be reported', () => {
    const fx = fixture();
    try {
      mkdirSync(join(fx.roots, 'other'), { recursive: true });
      writeFileSync(
        join(fx.roots, 'other', 'manifest.json'),
        JSON.stringify({
          apiVersion: 'devboard/v1',
          kind: 'Card',
          id: 'cpu-usage', // ← **the same id**
          name: 'another one',
          version: '1.0.0',
          description: 'x',
          entry: 'index.html',
          permissions: { read: [], write: [] },
          actions: [],
        }),
        'utf8',
      );
      writeFileSync(join(fx.roots, 'other', 'index.html'), '<!doctype html><html></html>', 'utf8');
      const wiring = wiringOf(fx);
      wiring.refresh();
      const degraded = wiring.list().filter((c) => c.degraded);
      expect(degraded.length).toBeGreaterThan(0);
    } finally {
      fx.cleanup();
    }
  });
});

describe('the card wiring · the lifecycle of a session', () => {
  it('the connection changed → **the session of the old instance is closed** (a subscription does not hang around forever)', () => {
    const fx = fixture();
    try {
      let connectionId: string | null = 'board-a';
      const wiring = wiringOf(fx, { connectionId: () => connectionId });
      wiring.refresh();
      const first = wiring.list()[0];
      expect(first).toBeDefined();
      wiring.sessions.open(first!.instanceId, 'cpu-usage', connectionId);

      connectionId = 'board-b';
      const second = wiring.list()[0];
      expect(second?.instanceId).not.toBe(first?.instanceId);
      expect(wiring.sessions.get(first!.instanceId)).toBeUndefined();
    } finally {
      fx.cleanup();
    }
  });
});

/**
 * **The cells of the work area follow the connection.**
 *
 * ── The kind of bug it prevents ──
 *
 * → A cell is bound to `(cardId, connectionId)` ✓ (contract `spec/03` §7 ✓)
 *   and the instances of the cards carry the **current** connection ✓ → when
 *   the connection changes ✓ the cell has to follow it ✓ (**otherwise the card
 *   is not placed any more** ✗ → it disappears from the main area ✗).
 * → The re-binding used to happen **only when the person switched the board
 *   by hand** ✗ — and the board that connects **on its own** at start ✗ (the
 *   usual case ✓) changed the connection id ✗ while the cells kept the old
 *   one ✗ → the card was gone ✗ (found on 2026-11-22 ✓).
 * → The path that matters is the one nobody clicks ✓: the runtime binds on
 *   its own ✓ → the cells have to follow it ✓.
 */
describe('the card wiring · the cells of the work area follow the connection', () => {
  it('**the board connects on its own → the cell follows it** (the card may not disappear ✗)', () => {
    const fx = fixture();
    try {
      // → **Nothing is connected yet** ✓ (the runtime has not bound ✗)
      let connectionId: string | null = null;
      const wiring = wiringOf(fx, { connectionId: () => connectionId });
      wiring.refresh();
      // → The card is placed while nothing is connected ✓ (the cell carries
      //   no connection ✓)
      wiring.layoutSet({
        version: 3,
        units: [{ cardId: 'cpu-usage', connectionId: null, x: 2, y: 1, w: 3, h: 2 }],
        density: 'comfortable',
        promoted: null,
        updatedAt: 0,
      });
      expect(wiring.layoutGet().units[0]?.connectionId).toBeNull();

      // → **The board connects** ✓ (the runtime binds on its own ✓ — nobody
      //   clicked anything ✗)
      connectionId = 'board-a';
      wiring.list();

      expect(
        wiring.layoutGet().units[0]?.connectionId,
        'the cell has to follow the connection — otherwise the card is not placed any more',
      ).toBe('board-a');
      // → **The position is kept** ✓ (the position is a fact about the card ✓)
      expect(wiring.layoutGet().units[0]).toMatchObject({ x: 2, y: 1, w: 3, h: 2 });
    } finally {
      fx.cleanup();
    }
  });

  it('**the connection is lost → the cell follows it back** (the card stays in the work area ✓)', () => {
    const fx = fixture();
    try {
      let connectionId: string | null = 'board-a';
      const wiring = wiringOf(fx, { connectionId: () => connectionId });
      wiring.refresh();
      wiring.layoutSet({
        version: 3,
        units: [{ cardId: 'cpu-usage', connectionId: 'board-a', x: 0, y: 0, w: 3, h: 2 }],
        density: 'comfortable',
        promoted: null,
        updatedAt: 0,
      });

      // → The page asks for the cards ✓ (the wiring sees the connection ✓)
      wiring.list();

      // → **The board is gone** ✓ (the connection failed ✗)
      connectionId = null;
      wiring.list();

      expect(wiring.layoutGet().units[0]?.connectionId).toBeNull();    } finally {
      fx.cleanup();
    }
  });
});

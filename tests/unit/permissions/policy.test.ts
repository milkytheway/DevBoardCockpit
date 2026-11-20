import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PermissionStore,
  defaultAllowed,
  type PermissionOperation,
} from '../../../src/main/permissions/policy';

/**
 * The unified permission area (the table of the settings page).
 *
 * Four criteria:
 *
 * | # | Criterion | Why |
 * |---|---|---|
 * | 1 | **a card writing to the board: forbidden by default** | **this blocks C2** — the **host cannot tell "the operator pressed a button" from "the card called it itself"**, so it is **not given by default** |
 * | 2 | **a card triggering a workflow: allowed by default** | **the existence of a workflow pack is the statement** — the card "compile and flash" **runs on a single click** |
 * | 3 | **an agent: allowed by default** | — **do not turn that off as well** |
 * | 4 | **a dangerous action: forbidden by default** (for both executors) | **"turning a permission on means the danger is known"** — turning it on is the assent (changed on 2026-11-16) |
 */
function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'perm-')), 'permissions.json');
}

const OPS: readonly PermissionOperation[] = [
  { op: 'action:backlight.set', label: 'set the backlight brightness', kind: 'action' },
  { op: 'action:system.reboot', label: 'reboot the board', kind: 'action' },
  { op: 'workflow:hello-kernel.build-run', label: 'compile the kernel module', kind: 'workflow' },
  { op: 'host:install_card', label: 'install a card', kind: 'host' },
];

describe('the unified permission area', () => {
  it('**a card writing to the board: forbidden by default** (C2 is blocked here)', () => {
    const store = new PermissionStore(tmpFile());
    expect(store.allows('card', 'action:backlight.set')).toBe(false);
    expect(store.allows('card', 'action:system.reboot')).toBe(false);
  });

  it('**a card triggering a workflow: allowed by default** (the gate is this switch)', () => {
    const store = new PermissionStore(tmpFile());
    expect(store.allows('card', 'workflow:hello-kernel.build-run')).toBe(true);
  });

  it('**an agent: allowed by default** (it has the assent of the operator in a different way)', () => {
    const store = new PermissionStore(tmpFile());
    expect(store.allows('agent', 'action:backlight.set')).toBe(true);
    expect(store.allows('agent', 'action:system.reboot')).toBe(true);
  });

  it('**a host operation: allowed by default**', () => {
    const store = new PermissionStore(tmpFile());
    expect(store.allows('card', 'host:install_card')).toBe(true);
  });

  it('**the operator can turn it on in the settings** (once — there is no popup any more)', () => {
    const store = new PermissionStore(tmpFile());
    store.set('card', 'action:backlight.set', true);
    expect(store.allows('card', 'action:backlight.set')).toBe(true);
    // **The other actions are not affected** (one switch per row)
    expect(store.allows('card', 'action:system.reboot')).toBe(false);
  });

  it('**it is stored even when it is turned off** (it survives a restart — a state of authorisation that belongs to the machine)', () => {
    const file = tmpFile();
    const store = new PermissionStore(file);
    store.set('card', 'action:system.reboot', true);
    store.set('agent', 'action:system.reboot', false);
    // **Opened again**
    const again = new PermissionStore(file);
    expect(again.allows('card', 'action:system.reboot')).toBe(true);
    expect(again.allows('agent', 'action:system.reboot')).toBe(false);
  });

  it('**a broken ledger falls back to the defaults** (the defaults forbid a card from writing to the board — the safe side)', () => {
    const file = tmpFile();
    const store = new PermissionStore(file);
    store.set('card', 'action:backlight.set', true);
    // **The ledger is broken on purpose**
    writeFileSync(file, '{ this is not json', 'utf8');
    const again = new PermissionStore(file);
    expect(again.allows('card', 'action:backlight.set')).toBe(false);
    expect(again.allows('card', 'workflow:x')).toBe(true);
  });

  it('**the table of the settings page: the explicit merged with the default**', () => {
    const store = new PermissionStore(tmpFile());
    store.set('card', 'action:backlight.set', true);
    const rows = store.rows(OPS);
    expect(rows.map((r) => r.op)).toEqual(OPS.map((o) => o.op));
    const row = rows.find((r) => r.op === 'action:backlight.set');
    expect(row?.card).toBe(true);
    expect(row?.agent).toBe(true);
    // **What was never set is still the default**
    const other = rows.find((r) => r.op === 'action:system.reboot');
    expect(other?.card).toBe(false);
  });

  it('**the default table is self-consistent** (changing one entry makes it fail)', () => {
    expect(defaultAllowed('card', 'action:x')).toBe(false);
    expect(defaultAllowed('card', 'workflow:x')).toBe(true);
    expect(defaultAllowed('card', 'host:x')).toBe(true);
    expect(defaultAllowed('agent', 'action:x')).toBe(true);
  });

  it('**a dangerous action: forbidden by default** (for both executors — "turning a permission on means the danger is known")', () => {
    // **A dangerous action is off by default** (turning it on is the assent)
    expect(defaultAllowed('card', 'action:x', true)).toBe(false);
    expect(defaultAllowed('agent', 'action:x', true)).toBe(false);
    // **A harmless action behaves as before** (this one may not be caught by mistake)
    expect(defaultAllowed('card', 'action:x', false)).toBe(false);
    expect(defaultAllowed('agent', 'action:x', false)).toBe(true);
  });

  it('**the danger level is read from the table of operations** (`setKnown` records the level, `allows` decides by it)', () => {
    const store = new PermissionStore(tmpFile());
    store.setKnown([
      { op: 'action:backlight.set', label: 'set the backlight brightness', kind: 'action', danger: 'reversible' },
      { op: 'action:system.reboot', label: 'reboot the board', kind: 'action', danger: 'destructive' },
      { op: 'workflow:build', label: 'compile', kind: 'workflow' },
    ]);
    // **A dangerous action: both executors are off by default**
    expect(store.allows('card', 'action:system.reboot')).toBe(false);
    expect(store.allows('agent', 'action:system.reboot')).toBe(false);
    // **A harmless action behaves as before** (an agent is on by default)
    expect(store.allows('agent', 'action:backlight.set')).toBe(true);
    // **A workflow is not judged by the danger level** (a workflow relies on "its
// existence is the statement")
    expect(store.allows('card', 'workflow:build')).toBe(true);
    // **The danger level can be asked for** (the settings page has to state it)
    expect(store.dangerOf('action:system.reboot')).toBe('destructive');
    expect(store.dangerOf('action:backlight.set')).toBe('reversible');
    expect(store.dangerOf('workflow:build')).toBeUndefined();
  });

  it('**the operator turns a dangerous action on → it is on** (that moment is the assent — there is no popup any more)', () => {
    const store = new PermissionStore(tmpFile());
    store.setKnown([
      { op: 'action:system.reboot', label: 'reboot the board', kind: 'action', danger: 'destructive' },
    ]);
    expect(store.allows('agent', 'action:system.reboot')).toBe(false);
    // **The operator turns it on in the settings** → **the explicit wins over the
// default**
    store.set('agent', 'action:system.reboot', true);
    expect(store.allows('agent', 'action:system.reboot')).toBe(true);
    // **On the side of the card it is still off** (the two executors are recorded
// apart)
    expect(store.allows('card', 'action:system.reboot')).toBe(false);
  });

  it('**the ledger is JSON** (a person can read it)', () => {
    const file = tmpFile();
    const store = new PermissionStore(file);
    store.set('card', 'action:x', true);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { card: Record<string, boolean> };
    expect(parsed.card['action:x']).toBe(true);
  });
});

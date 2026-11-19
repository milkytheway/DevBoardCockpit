import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The unified permission area (the user on 2026-11-16: "add a unified
 * permission area to the settings, so that every meta-operation can be given
 * or denied permission here" ✓ · implementation decision record ADR-D47 ✓).
 *
 * ── Why it has to exist ──
 *
 * → Authorization was scattered over several places ✗ (asked once when a
 *   card is installed ✓ · asked once before running a workflow ✓ · asked once
 *   before a dangerous command ✓ · asked once before executing ✓) → "this
 *   needs consent and that needs consent" ✗.
 * → One place ✓: a list of operations in the settings, one switch each ✓ —
 *   you can turn one off whenever you want ✓.
 * → No more pop-ups ✓ — a switch is visible ✓, a pop-up interrupts people ✓.
 *
 * ── Two kinds of actor (kept apart ✓) ──
 *
 * | Actor | Who can trigger it | Default |
 * |---|---|---|
 * | A card | A card in the UI ✓ (the user clicks its button ✓) | Writing to the board: forbidden ✓ · Triggering a workflow: allowed ✓ |
 * | `agent` | The MCP route ✓ (the agent calls a tool ✓) | Allowed ✓ (the dangerous kind is off by default ✓ — one rule for both kinds of actor ✓) |
 *
 * → Cards are not allowed to write to the board by default ✓ — that closes
 *   C2 ✓:
 *   the host cannot tell "a human clicked the button on a card" from "the
 *   card's own JS called the same API" ✗
 *   → so it is not granted by default ✓ → whoever wants to write to the board
 *   turns it on in the settings ✓ (once ✓ · visible ✓).
 * → The agent route is not affected ✓ — its own row of switches decides ✓
 *   (the `confirm_action` scheme is gone as of 2026-11-16 ✓ · implementation
 *   decision record ADR-D48 ✓).
 *
 * ── The key of an operation ──
 *
 * `action:<action id>` ✓ · `workflow:<workflow id>` ✓ · `host:<host operation>` ✓
 * → With a prefix ✓ — so that an action id cannot collide with a workflow id ✓.
 */
export type PermissionActor = 'card' | 'agent';

/** One kind of operation */
export type PermissionKind = 'action' | 'workflow' | 'host';

/** The prefix of an operation key (closed ✓) */
export const KIND_PREFIX: Record<PermissionKind, string> = {
  action: 'action:',
  workflow: 'workflow:',
  host: 'host:',
};

/**
 * The known operations (filled in by the host ✓ — recomputed every time
 * another board is plugged in ✓).
 *
 * → They carry a danger level ✓ — the default rules depend on it ✓
 *   ("a dangerous action is off by default" ✓).
 */
const KNOWN_OPS = new Map<string, PermissionOperation>();

/** The host-side operations (the fixed ones ✓ — every one of them has to be switchable off ✓) */
export const HOST_OPERATIONS = [
  'install_card',
  'uninstall_card',
  'promote_card',
] as const;

/**
 * The defaults (an operation that was never set follows these ✓).
 *
 * → A card writing to the board: forbidden ✓ (C2 ✓)
 * → A card triggering a workflow: allowed ✓ (the gate is this switch ✓ —
 *   the "compile onto the board" card executes on a single click ✓ — which
 *   is exactly what the user wants ✓)
 * → `agent`: allowed ✓ (its side has the same switch ✓)
 * → Host operations: allowed ✓
 */
export function defaultAllowed(
  actor: PermissionActor,
  op: string,
  dangerous = false,
): boolean {
  // A dangerous action: off by default ✓ ("turning a permission on means you
  // know it is dangerous" ✓ — turning it on is that informed consent ✓)
  if (dangerous) return false;
  if (actor === 'agent') return true;
  // A card: only the "write to the board" kind is forbidden ✓
  if (op.startsWith(KIND_PREFIX.action)) return false;
  return true;
}

/** What one operation looks like in the settings */
export interface PermissionOperation {
  /** The key of the operation (`action:backlight.set` ✓) */
  op: string;
  /** The display name */
  label: string;
  /** The kind */
  kind: PermissionKind;
  /** The explanation for this kind (in plain language ✓) */
  hint?: string;
  /** How dangerous this action is ✓ (only actions have this ✓ — a workflow relies on "its existence is the explanation" ✓) */
  danger?: 'reversible' | 'destructive';
}

/** The table the settings page draws (one switch per row ✓) */
export interface PermissionRow extends PermissionOperation {
  /** Whether a card may use it */
  card: boolean;
  /** Whether the agent may use it */
  agent: boolean;
}

/** The shape of what is stored on disk */
interface PolicyFile {
  card: Record<string, boolean>;
  agent: Record<string, boolean>;
}

/**
 * The permission ledger (in the user data directory ✓ — the authorisation
 * state of a specific machine does not go into the version control ✓).
 *
 * → If it cannot be read, it counts as "the defaults" ✓ (the default
 *   forbids a card from writing to the board ✓ — the safe side ✓).
 */
export class PermissionStore {
  /** Which operations this table holds (the host refreshes it on every listing ✓) */
  setKnown(operations: readonly PermissionOperation[]): void {
    KNOWN_OPS.clear();
    for (const operation of operations) KNOWN_OPS.set(operation.op, operation);
  }

  private readonly policy: PolicyFile = { card: {}, agent: {} };

  constructor(private readonly filePath: string) {
    this.load();
  }

  /** May this actor use this operation */
  allows(actor: PermissionActor, op: string): boolean {
    const explicit = this.policy[actor][op];
    if (explicit !== undefined) return explicit;
    return defaultAllowed(actor, op, this.isDangerous(op));
  }


  /** Set one (idempotent ✓) */
  set(actor: PermissionActor, op: string, allowed: boolean): void {
    if (this.policy[actor][op] === allowed) return;
    this.policy[actor][op] = allowed;
    this.save();
  }

  /**
   * Does this operation exist (setting an operation that does not exist is
   * not allowed ✓).
   *
   * → Without the check a pile of junk keys would be stored ✓ (and nobody
   *   would ever see them ✓) ✓
   */
  knows(op: string): boolean {
    return KNOWN_OPS.has(op);
  }

  /** How dangerous this operation is ✓ (the settings page has to say it ✓ — "turning a permission on means you know it is dangerous" ✓) */
  dangerOf(op: string): 'reversible' | 'destructive' | undefined {
    return KNOWN_OPS.get(op)?.danger;
  }

  /** Is it a dangerous action ✓ (off by default ✓ — turning it on is that informed consent ✓) */
  private isDangerous(op: string): boolean {
    return KNOWN_OPS.get(op)?.danger === 'destructive';
  }

  /** All of them (for the settings page ✓ — the explicit ones merged with the defaults ✓) */
  rows(operations: readonly PermissionOperation[]): PermissionRow[] {
    return operations.map((operation) => ({
      ...operation,
      card: this.allows('card', operation.op),
      agent: this.allows('agent', operation.op),
    }));
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<PolicyFile>;
      this.policy.card = { ...(parsed.card ?? {}) };
      this.policy.agent = { ...(parsed.agent ?? {}) };
    } catch {
      // It cannot be read → use the defaults ✓ (in the defaults a card
      // writing to the board is forbidden ✓ — the safe side ✓)
      this.policy.card = {};
      this.policy.agent = {};
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.policy, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
  }
}

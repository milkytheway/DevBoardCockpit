import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Action audit — contract `docs/spec/02-board-pack.md` §5.4.
 *
 * > "Record one line per action execution: time, card id, action id,
 * > parameters, result, readback value. … append-only, flush every line,
 * > timestamp prefix."
 *
 * ── What is recorded is every attempt, not only the ones that succeeded ──
 *
 * The contract's minimum requirement is "one line per execution"; here every
 * attempt gets a line (including the denied ones and the ones waiting for
 * confirmation) — "who tried what but was not allowed" is precisely the class
 * of event that most deserves a trace.
 *
 * ── Line-oriented text, not a JSON file ──
 *
 * The same shape as the session log (`logging/session-log.ts`): it can be
 * grepped, tailed and catted. One action per line, append-only, flush every
 * line.
 */
export interface AuditRow {
  /**
   * The id of this line (the unit of accountability).
   *
   * Contract `spec/04` §2.4: the action result carries an `audit_id` —
   * "what happened" and "who caused it" have to be able to point at each
   * other. (Implementation decision record ADR-D31 R8: every stage of the
   * workflow-layer timeline references this id as well.)
   */
  id?: string;
  /** Timestamp (milliseconds UTC) */
  at: number;
  /** Who triggered it (card id / agent / user) */
  actor: string;
  /** The action id declared in the board pack */
  actionId: string;
  /** The parameters of this call (raw values) */
  params: Record<string, unknown>;
  /**
   * The final command, the one after encoding.
   *
   * → It is the first link in the chain of accountability: "what exactly was
   *   executed". (With only the action id and the parameters, the command
   *   cannot be reconstructed afterwards.)
   * → The workflow layer needs it especially: a workflow's command is given
   *   by the workflow pack (not by an action in the board pack).
   */
  command?: string;
  /**
   * The input values of this step (used by the workflow layer).
   *
   * → A workflow's parameters are declared in the workflow pack, not in the
   *   board pack → without this, afterwards you only see "some step ran", not
   *   "which project was used".
   */
  inputs?: Record<string, unknown>;
  /** Did the action succeed */
  ok: boolean;
  /** Was it confirmed that the board really reached the target state */
  verified: boolean;
  /** The value read back */
  value?: unknown;
  /** One line for a human to read */
  detail?: string;
}

/** Timestamp prefix (ISO, in its readable form without milliseconds) */
function stamp(at: number): string {
  return new Date(at).toISOString();
}

/** One audit line (line-oriented text, fields separated by spaces) */
export function formatAuditRow(row: AuditRow): string {
  const parts = [
    stamp(row.at),
    ...(row.id === undefined ? [] : [`id=${row.id}`]),
    `actor=${row.actor}`,
    `action=${row.actionId}`,
    `params=${JSON.stringify(row.params)}`,
    `ok=${String(row.ok)}`,
    `verified=${String(row.verified)}`,
  ];
  if (row.command !== undefined) parts.push(`command=${JSON.stringify(row.command)}`);
  if (row.inputs !== undefined) parts.push(`inputs=${JSON.stringify(row.inputs)}`);
  if (row.value !== undefined) parts.push(`value=${JSON.stringify(row.value)}`);
  if (row.detail !== undefined) parts.push(`detail=${JSON.stringify(row.detail)}`);
  return parts.join(' ');
}

/**
 * Where the audit is written to disk.
 *
 * Append-only, flush every line — a crash or a power loss must not lose
 * writes that already happened (the reason given in contract §5.4 is the
 * same as for the session log: fact G4).
 */
export class ActionAudit {
  /** Row number (the order within the same audit file) */
  private seq = 0;

  constructor(private readonly filePath: string) {}

  /**
   * Record one line and return the id of that line.
   *
   * → It is the `audit_id` in the result (contract `spec/04` §2.4).
   */
  append(row: AuditRow): string {
    this.seq += 1;
    // The id must be unpredictable (finding V2-M10 of review 35 ✓):
    // A timestamp plus a sequence number can be guessed ✗ → and the audit_id
    // is handed to cards/agents ✓ → guessing somebody else's audit_id lets
    // you point at somebody else's record and say "they did it" ✗.
    const id = row.id ?? `audit-${randomUUID().slice(0, 8)}`;
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${formatAuditRow({ ...row, id })}\n`, 'utf8');
    return id;
  }
}

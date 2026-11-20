import { matchTagPattern } from '../tags/vocabulary';

/**
 * The permission set of a card (contract `spec/03` §2).
 *
 * ── In one line ──
 *
 * > Every entry of `requires` must be covered by **some** entry of
 * > `permissions`.
 *
 * **"Covered", not "equal"** — that lets a card state an exact need and still
 * ask for a broader read permission (the other way round does not hold).
 *
 * **Why the read permissions are patterns and the write ones are not**
 * (contract §2.3): reading a `cpu.usage` has no side effect; writing an action
 * changes the board. A pattern widens the scope of the authorisation, which is
 * convenient for reading and **dangerous** for writing.
 */
export interface CardPermissions {
  read: string[];
  write: string[];
  /** The **workflow ids** this card may trigger (the second authorisation dimension ✓ — review 37, V3-I9 ✓) */
  workflows?: string[];
}

/**
 * Is this tag covered by the read permissions?
 *
 * The implementation is `perms.read.some((p) => matchTagPattern(p, tag))` —
 * it **reuses the one matcher of the vocabulary layer** instead of writing a
 * second set of rules (a second set will eventually disagree with the first).
 */
export function permissionCovers(perms: CardPermissions, tag: string): boolean {
  return perms.read.some((pattern) => matchTagPattern(pattern, tag));
}

/**
 * Is every entry of `requires` covered by the read permissions? (the boolean
 * form of contract §2.2)
 *
 * **The M5 validator does not use it** — rule 3 reports **per entry** (it
 * tells the reader "which one is not covered"), which is more useful than a
 * boolean. The M6 authorisation check uses it.
 */
export function requiresSatisfied(requires: string[], perms: CardPermissions): boolean {
  return requires.every((tag) => permissionCovers(perms, tag));
}

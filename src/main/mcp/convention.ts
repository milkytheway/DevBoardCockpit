/**
 * The **common convention of the MCP responses** (contract `spec/04` §4 ✓).
 *
 * ── Why it is a module of its own ──
 *
 * → **Every response carries `apiVersion`** ✓ (contract §4 ✓) — both the
 *   workflow tools and the read tools **have to use it** ✓ → **one
 *   implementation** ✓ (a copy in each place drifts eventually ✓).
 *
 * → **In a list every entry carries it** ✓ (and not only one at the top ✓) —
 *   the words of the contract: "the `apiVersion` field is carried in every
 *   response" ✓.
 */

/** The contract version (the `apiVersion` in a response means the contract version ✓ — not the version of the tool set itself ✓) */
export const API_VERSION = 'devboard/v1';

/** Adds `apiVersion` to a value ✓ */
export function withVersion<T>(value: T): T & { apiVersion: string } {
  return { apiVersion: API_VERSION, ...value };
}

/** Adds it to every entry of a list ✓ */
export function withVersionEach<T>(items: T[]): (T & { apiVersion: string })[] {
  return items.map((item) => ({ apiVersion: API_VERSION, ...item }));
}

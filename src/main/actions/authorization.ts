import type { ActionDef, PackGuard, PackParam } from '../tags/schema';

/**
 * Authorization — contract `docs/spec/02-board-pack.md` §5.5 + `spec/04` §2.4.
 *
 * ── Only two criteria (cut down on 2026-11-16 ✓ · implementation decision
 *    record ADR-D48 ✓) ──
 *
 * | Criterion | When it is not met |
 * |---|---|
 * | Is this action in the granted set ✓ (declared by the card's manifest ✓ / an agent's granted set = all the actions of the current pack ✓) | Denied ✓ |
 * | Do the parameters fall inside the `guard` domain ✓ (the guard is the line the pack author drew ✓ — contract §5.5 ✓) | Denied ✓ |
 *
 * ── There is no more "stop and ask a human" ✓ ──
 *
 * → `destructive` is only information ✓ (it is written down in the
 *   permission area of the settings page ✓ — "turning a permission on means
 *   you know it is dangerous" ✓).
 * → Hitting the danger floor no longer requires a confirmation ✓ (the floor
 *   is there for validation and display ✓ — contract §5.2.1 ✓).
 * → Outside the guard domain → denied ✓ (it is not a question of "should we
 *   ask" ✓ — that is the line the pack author drew ✓).
 *
 * → To control what may be done, use the unified permission area in the
 *   settings ✓ (implementation decision record ADR-D47 ✓) — one place, one
 *   switch ✓.
 */

  /** Granted actions (**the card declares them** ✓ — the permission area decides whether they may run ✓) */
export interface GrantedActions {
  /**
   * Action id → the approved parameter domain (by parameter name, the same
   * shape as the action's own `guard`).
   *
   * `undefined` = the action was approved but its parameter domain was not
   * narrowed (equivalent to guard = the full domain the parameter itself
   * declares).
   */
  actions: Record<string, Record<string, PackGuard> | undefined>;
}

  /** The authorization verdict (on 2026-11-16 there is no "needs confirmation" tier any more ✓ — implementation decision record ADR-D48 ✓) */
export type AuthorizationVerdict = 'ok' | 'denied';

  /** The authorization result */
export interface AuthorizationResult {
  verdict: AuthorizationVerdict;
  /** One line for a human to read */
  detail?: string;
  /** Which parameter went out of its domain (say exactly which one ✓) */
  param?: string;
}

  /** Does a value fall inside this domain */
function withinRange(value: unknown, range: { min?: number; max?: number } | undefined): boolean {
  if (range === undefined) return true;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (range.min !== undefined && value < range.min) return false;
  if (range.max !== undefined && value > range.max) return false;
  return true;
}

/**
 * Decide whether this action may be executed directly (failing a criterion
 * is a denial ✓ — there is no third outcome ✓).
 *
 * @param action The action declared in the board pack
 * @param params The raw parameter values of this call
 * @param granted The granted set (declared by the card's manifest ✓ / for an
 *   agent, = all the actions of the current pack ✓)
 */
export function authorize(
  action: ActionDef,
  params: Record<string, unknown>,
  granted: GrantedActions,
): AuthorizationResult {
  // 1) Is this action in the granted set
  if (!Object.prototype.hasOwnProperty.call(granted.actions, action.id)) {
    return { verdict: 'denied', detail: `action "${action.id}" was not granted` };
  }

    // 2) The parameter domain: the guard is the line the pack author drew ✓
    //    (contract §5.5 ✓)
    //    → Outside it, deny ✓ (it is not a question of "should we ask" ✓ —
    //      implementation decision record ADR-D48 ✓)
  const grantedDomain = granted.actions[action.id];
  const guard = action.guard ?? {};
  for (const [name, spec] of Object.entries(action.params ?? {})) {
    const paramSpec = spec as PackParam;
    // The parameter domain only governs numeric parameters — min/max are
    // numbers, and applying them to a string/enum only produces a false
    // denial of "always out of range".
    // (String length is handled by `maxLength`; the encoder already rejects
    // those.)
    if (paramSpec.type !== 'integer' && paramSpec.type !== 'number') continue;
    const range =
      grantedDomain?.[name] ?? guard[name] ?? { min: paramSpec.min, max: paramSpec.max };
    if (!withinRange(params[name], range)) {
      return {
        verdict: 'denied',
        param: name,
        detail: `parameter "${name}" is outside the range this action allows (${describeRange(range)})`,
      };
    }
  }

  return { verdict: 'ok' };
}

/** Put the range into plain language */
function describeRange(range: { min?: number; max?: number }): string {
  if (range.min !== undefined && range.max !== undefined) return `${range.min} .. ${range.max}`;
  if (range.min !== undefined) return `≥ ${range.min}`;
  if (range.max !== undefined) return `≤ ${range.max}`;
  return '(no limit)';
}

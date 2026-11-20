import { invokeAction, type ActionExecutorDeps, type ActionOutcome } from '../actions/executor';
import { buildCommand } from '../actions/encoder';
import type { ActionDef } from '../tags/schema';
import type { GrantedActions } from '../actions/authorization';

/**
 * The **action execution of the agent** (contract `spec/04` §2.4 / §2.4.1 ✓ ·
 * ADR-D40 ✓).
 *
 * ── The authorisation of the agent and the card are **not the same set** ✓ ──
 *
 * | | card | agent |
 * |---|---|---|
 * | authorisation set | **all the actions declared by the current board pack** ✓ (**the card and the agent use the same one** ✓ — ADR-D46 ✓) | **all the actions declared by the current board pack** ✓ |
 * | range of the parameters | **the `guard` of the action itself** ✓ (**there is no narrower range that was authorised** ✓ — ADR-D46 ✓) | **the `guard` of the action itself** ✓ |
 *
 * → Contract §2.4.1: "the agent is not a card, it has an authorisation of its
 *   own" ✓
 *   "the agent can call any action directly, **without installing a card
 *   first**" ✓.
 *
 * → **`destructive` is no longer approved one by one** ✓ (**2026-11-16** ✓ ·
 *   ADR-D48 ✓) →
 *   **the gate is the unified permission area of the settings** ✓ (ADR-D47 ✓ —
 *   **that kind of action is off by default** ✓).
 *
 * ── Where `dry_run` stands (**the behaviour table of contract §2.4** ✓) ──
 *
 * ```
 * 1. check the existence → not_found
 * 2. check the authorisation → denied
 * 3. validate the parameters → invalid_params
 * 4. dry_run  → return the command that would be run (**it does not execute, does not read back and does not write the audit** ✓)
 * 7. execute → 8. read back → 9. audit ✓
 * ```
 *
 * → **Step 4 comes before steps 5/6** ✓ — otherwise the agent would never get
 *   a preview of a destructive action ✗.
 */

/**
 * The dependencies of the executor (**the same executor as the card side** ✓ —
 * the semantics are consistent by nature ✓).
 *
 * → **`packId` keeps the shape the executor wants** (**a string** ✓) —
 *   **the issuing side and the consuming side have to be bound to the same
 *   value** ✓ (the binding table of contract §2.4.1 ✓) →
 *   when the two differ → **the credential can never be consumed** ✗ (that is
 *   **the most insidious kind of defect** ✓ — the symptom is "the person
 *   clicked and nothing happened" ✓).
 */
export interface AgentActionDeps extends Omit<ActionExecutorDeps, 'granted' | 'actor'> {
  /** The actions declared in the current board pack (**the authorisation set of the agent is exactly those** ✓) */
  actions: () => ActionDef[];
  /**
     * The **id of the current board pack** (**the credential is bound to it** ✓).
     *
     * → **It has to be the same value as the one the executor uses** ✓ (**the
     *   same source** ✓) ✓
     * → **It is taken from the same place** when the host is wired up ✓.
     */
  packIdOf: () => string;
  /**
     * The **`device_key` of the board of the current runtime** ✓ (**inherited
     * from `ActionExecutorDeps`** ✓).
     *
     * → **The device check of `execute_action` relies on it** ✓ (contract
     *   `spec/04` §2.4 ✓)
     * → **The credential is bound to it as well** ✓ (§2.4.1, sixth item ✓).
     */
  deviceKey: () => string;
}

/** The authorisation set of the agent (**all the actions of the pack** ✓ — contract §2.4.1 ✓) */
export function agentGrants(actions: ActionDef[]): GrantedActions {
  const granted: GrantedActions['actions'] = {};
  for (const action of actions) {
    // **`undefined` = this action was approved but its range of parameters was **not narrowed** ✓
    // → The range of the parameters falls back to **the `guard` of the action itself** ✓ (contract §2.4.1, detail 2 ✓)
    granted[action.id] = undefined;
  }
  return { actions: granted };
}

/** The action does not exist → `not_found` ✓ */
export interface ActionNotFound {
  ok: false;
  reason: 'not_found';
  detail: string;
}

/** The result of the execution (**the shape of contract §2.4** ✓) */
export interface AgentActionResult {
  ok: boolean;
  /** The real state that was read back */
  readback?: { value?: unknown; unit?: string; status?: string; at: number };
  /** Did the board really enter the target state ✓ (`verified: false` is not a failure ✓ — contract §2.4 ✓) */
  verified?: boolean;
  /** The unit of accountability ✓ */
  audit_id?: string;
  /** The reason of the failure (**a closed table** ✓ — contract §4 ✓) */
  reason?: string;
  /** The credential that is given when a person has to approve ✓ */
  /** The parameters are outside the range of the guard ✓ (**a flag, not a reason code** ✓) */
  guard_exceeded?: boolean;
  /** The expected value / the actual value ✓ */
  expected?: unknown;
  actual?: unknown;
  /** One sentence meant for a human ✓ */
  detail?: string;
  /** The shape of the dry run ✓ */
  dry_run?: boolean;
  /** The final command the dry run has to return ✓ (**the encoded one** ✓ — not the template ✓) */
  command?: string;
  /** The tag the readback has to read ✓ */
  readback_tag?: string | null;
}

/**
 * **Executes an action** (agent side) ✓.
 *
 * → **A thin wrapper** ✓: it reuses **the same executor** ✓ (the card side
 *   uses the same one ✓ — there is only one chain of seven steps ✓).
 */
export async function executeAction(
  deps: AgentActionDeps,
  actionId: string,
  params: Record<string, unknown>,
  opts: { dryRun?: boolean; deviceKey?: string } = {},
): Promise<AgentActionResult> {
  // ── **Step 0 · is it the right device** ✓ (contract `spec/04` §2.4 ✓ · ADR-D43 ✓) ──
  //
  // → **When a `device_key` is given it has to be the `device_key` of the connection of the current runtime** ✓
  // → otherwise **`not_found`** ✓ (the detail says "no such device: X" ✓)
  // → **"Ignore the `device_key` and hit the current board" is never allowed** ✓
  //   (**that is "silently doing something else"** ✗ — the agent thinks it moved b while it moved a ✗)
  //
  // → **It comes before step 1** ✓ — **the wrong device** is more fundamental than **the action not existing** ✓
  const deviceError = checkDevice(deps, opts.deviceKey);
  if (deviceError !== undefined) return deviceError;

  const action = deps.actions().find((a) => a.id === actionId);
  // **① The existence is checked first** ✓ (contract §2.4 ✓ — **the order matters** ✓)
  if (action === undefined) {
    return { ok: false, reason: 'not_found', detail: `No such action: ${actionId}` };
  }

  // **③ Validation of the parameters + encoding** ✓ (**the dry run has to pass this step as well** ✓ — otherwise what it returns is not "what will be run" ✓)
  let command: string;
  try {
    command = buildCommand(action.command, action.params ?? {}, params).command;
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid_params',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // **④ dry_run** ✓ — **before the execution** ✓ (the behaviour table of contract §2.4 ✓)
  if (opts.dryRun === true) {
    return {
      ok: true,
      dry_run: true,
      command,
      readback_tag: readbackTagOf(action),
      // **It does not execute, does not read back and does not write the audit** ✓ (**it is not an attempt** ✓)
    };
  }

  // **It goes through the same executor** ✓ (the card side uses the same one ✓ — there is only one chain of seven steps ✓)
  const outcome: ActionOutcome = await invokeAction(action, params, {
    ...deps,
    // **The authorisation set of the agent = all the actions of the pack** ✓ (contract §2.4.1 ✓)
    granted: () => agentGrants(deps.actions()),
    actor: 'agent',
  });

  return projectOutcome(outcome);
}

/**
 * **Is the `device_key` right** ✓ (contract `spec/04` §2.4 ✓).
 *
 * → **Leaving it out lets it pass** ✓ (**the board of the current runtime** ✓
 *   — the behaviour of before ✓)
 * → **When it is given it has to match** ✓ → otherwise **`not_found`** ✓
 * → **It never silently hits the current board** ✓.
 */
function checkDevice(
  deps: AgentActionDeps,
  deviceKey: string | undefined,
): AgentActionResult | undefined {
  if (deviceKey === undefined) return undefined;
  const current = deps.deviceKey();
  if (deviceKey === current) return undefined;
  return {
    ok: false,
    reason: 'not_found',
    detail: `No such device: ${deviceKey} (the current one is ${current || 'none'})`,
  };
}

/** **Projects the result of the executor into the shape of the contract** ✓ */
function projectOutcome(outcome: ActionOutcome): AgentActionResult {
  const result: AgentActionResult = { ok: outcome.ok };
  if (outcome.readback !== undefined) {
    result.readback = {
      ...(outcome.readback.value === undefined ? {} : { value: outcome.readback.value }),
      ...(outcome.readback.unit === undefined ? {} : { unit: outcome.readback.unit }),
      ...(outcome.readback.status === undefined ? {} : { status: outcome.readback.status }),
      at: outcome.readback.at,
    };
  }
  // **`verified: false` means "it was executed but not read back"** ✓ — **not a failure** ✓ (contract §2.4 ✓)
  result.verified = outcome.verified;
  if (outcome.audit_id !== undefined) result.audit_id = outcome.audit_id;
  if (outcome.reason !== undefined) result.reason = outcome.reason;
  if (outcome.expected !== undefined) result.expected = outcome.expected;
  if (outcome.actual !== undefined) result.actual = outcome.actual;
  if (outcome.detail !== undefined) result.detail = outcome.detail;
  return result;
}

/** Which tag the readback of this action has to read (**`null` when it is not in the form of a tag** ✓) */
function readbackTagOf(action: ActionDef): string | null {
  const readback = action.readback;
  if (readback === undefined) return null;
  if (readback.kind !== undefined && readback.kind !== 'tag') return null;
  return readback.tag ?? null;
}


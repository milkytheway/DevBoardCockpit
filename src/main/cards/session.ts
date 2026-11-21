import { apiByName, type CardApiContext, type CardServices } from './api-registry';
import { permissionCovers, type CardPermissions } from './permissions';
import { TagsService, type TagsServiceDeps } from './tags-service';
import type { TagReading } from '../../shared/tag-reading';
import type { CardRequest, CardResponse } from '../../shared/ipc-contract';

/**
 * The **session** of one card instance.
 *
 * ── The session is the carrier of the permissions ──
 *
 * The permission set is fixed **when the card is installed** (contract §3.3: a
 * card cannot raise its permissions at runtime).
 * The session carries it, so "what this instance may see" is **the same
 * answer** on **every** layer: the read filter, the subscription filter and
 * the list filter all use `session.perms`.
 *
 * ── Why the session lives in main and not in the page ──
 *
 * The page is the untrusted side (the card lives right next to it).
 * The permission decision **has to be made in a trusted process**.
 */

/** The source of the readings (the TagStore satisfies it) */
export interface RuntimeReader {
  readings(): TagReading[];
  subscribe(cb: (r: TagReading) => void): () => void;
}

export interface CardSession {
  instanceId: string;
  cardId: string;
  connectionId: string | null;
  perms: CardPermissions;
  createdAt: number;
  services: CardServices;
}

export interface CardSessionManagerDeps {
  /** The source of the readings */
  runtime: RuntimeReader;
  /** The permission set of this card (from the manifest plus the authorised actions) */
  permsFor: (cardId: string) => CardPermissions;
  now?: () => number;
  /** Pushes to one instance (wired up in task 10) */
  push?: (instanceId: string, payload: unknown) => void;
  /**
     * The storage of each card (**separated per card id** — the storage is one
     * namespace per card).
     *
     * Made a "factory" and not a single instance: the session is **one per
     * card**, and the storage has to follow the card, otherwise a write of card
     * A would land on card B.
     */
  storageFor?: (cardId: string) => CardServices['storage'];
  /** The log of each card */
  logFor?: (cardId: string) => (level: 'error' | 'warn' | 'info', message: string) => void;
  /**
     * The write side of each card (the action executor).
     *
     * Made a **factory** and not a single instance: the executor has to hold the
     * **authorisation of this card**, and the authorisation is one per card.
     */
  actionsFor?: (cardId: string) => CardServices['actions'];
  /**
     * The **workflow side** of each card (plan 7 ✓).
     *
     * Made a **factory**: the authorisation of a workflow is one per card ✓
     * (the same shape as `actionsFor` ✓).
     */
  workflowsFor?: (cardId: string) => CardServices['workflows'];
  /** Complete serial boot-log capture for the card. */
  bootLogFor?: (cardId: string) => CardServices['bootLog'];
  /** The identity of the current connection (for `capabilities()`) */
  connectionInfo?: (connectionId: string | null) => { label: string; transport: string } | null;
}

/**
 * How many subscriptions one instance may hold at most (RF-4).
 *
 * ── Why there is an upper bound ──
 *
 * A card is an arbitrary web page written by an AI. It can **subscribe in a
 * loop**:
 * ```
 * setInterval(() => cockpit.tags.subscribe('cpu.usage', cb), 100)
 * ```
 * Every subscription adds one more listener to the runtime → every push fans
 * out into N copies → **the memory and the IPC of main are flooded** and the
 * workbench freezes with them.
 *
 * Contract §6: "**one card crashing does not affect the other cards, and does
 * not affect the workbench**" — here "affects" means "fills main up".
 *
 * → The upper bound is kept by the **host** (a card does not restrain itself).
 * When it is exceeded the answer is
 * `{ ok:false, reason:'too_many_subscriptions' }` (contract §7.7: it does not
 * throw, it returns a failure).
 */
export const MAX_SUBSCRIPTIONS_PER_SESSION = 64;

export class CardSessionManager {
  private readonly sessions = new Map<string, CardSession>();
  /**
     * The subscriptions of each instance → the unsubscribe function (RF-4).
     *
     * **Why it has to be kept**: the unsubscribe function returned by
     * `deps.subscribe` is the **only** thing that can really take the listener
     * off the runtime. Losing it = the subscription can never be released.
     */
  private readonly subscriptions = new Map<string, Map<string, () => void>>();

  constructor(private readonly deps: CardSessionManagerDeps) {}

  /** Opens a session (calling it again for the same instance returns the same session) */
  open(instanceId: string, cardId: string, connectionId: string | null): CardSession {
    const existing = this.sessions.get(instanceId);
    if (existing !== undefined) return existing;

    const perms = this.deps.permsFor(cardId);
    const now = this.deps.now ?? (() => Date.now());
    /** The subscriptions of this instance (subscription id → unsubscribe function) */
    const subs = new Map<string, () => void>();
    this.subscriptions.set(instanceId, subs);
    const tagsDeps: TagsServiceDeps = {
      readings: () => this.deps.runtime.readings(),
      subscribe: (cb) => this.deps.runtime.subscribe(cb),
      now,
    };
    const tags = new TagsService(perms, tagsDeps);
    const push = this.deps.push;

    const services: CardServices = {
      tags: {
        get: (name) => tags.get(name),
        list: () => tags.list(),
        subscribe: (name, subscriptionId) => {
          if (subs.size >= MAX_SUBSCRIPTIONS_PER_SESSION) {
            return { ok: false, reason: 'too_many_subscriptions' };
          }
          // **The unsubscribe function has to be kept** — otherwise this subscription can never be released (RF-4)
          const dispose = tags.subscribe(name, (reading) => {
            push?.(instanceId, { type: 'push', subscriptionId, value: reading });
          });
          subs.set(subscriptionId, dispose);
          return { ok: true };
        },
        subscribePattern: (pattern, subscriptionId) => {
          if (subs.size >= MAX_SUBSCRIPTIONS_PER_SESSION) {
            return { ok: false, reason: 'too_many_subscriptions' };
          }
          const dispose = tags.subscribePattern(pattern, (reading) => {
            push?.(instanceId, { type: 'push', subscriptionId, value: reading });
          });
          subs.set(subscriptionId, dispose);
          return { ok: true };
        },
        degradation: () => tags.degradation(),
      },
      actions: this.deps.actionsFor?.(cardId) ?? emptyActions(),
      // **The workflow side** (plan 7 ✓) — while it is not wired up everything is **refused** ✓ (not "let it pass" ✗)
      workflows: this.deps.workflowsFor?.(cardId) ?? emptyWorkflows(),
      bootLog: {
        capture: async () => {
          if (!(perms.workflows ?? []).includes('boot-log.capture')) {
            return { ok: false, reason: 'denied' };
          }
          return this.deps.bootLogFor?.(cardId).capture() ?? { ok: false, reason: 'denied' };
        },
        latest: async () => {
          if (!(perms.workflows ?? []).includes('boot-log.capture')) {
            return { ok: false, reason: 'denied' };
          }
          return this.deps.bootLogFor?.(cardId).latest() ?? null;
        },
      },
      storage: this.deps.storageFor?.(cardId) ?? emptyStorage(),
      log: (level, message) => {
        this.deps.logFor?.(cardId)(level, message);
      },
    };

    const session: CardSession = { instanceId, cardId, connectionId, perms, createdAt: now(), services };
    this.sessions.set(instanceId, session);
    return session;
  }

  /** Fetches a session */
  get(instanceId: string): CardSession | undefined {
    return this.sessions.get(instanceId);
  }

  /**
     * Closes a session (the card is gone / the connection changed / the card was
     * reloaded).
     *
     * **The unsubscribe functions are called here** — this is the only guarantee
     * that "the subscriptions do not hang around forever".
     */
  close(instanceId: string): void {
    const subs = this.subscriptions.get(instanceId);
    if (subs !== undefined) {
      for (const dispose of subs.values()) {
        // A failing unsubscribe **must not block the host** (a problem of one card must not bring down the whole session)
        try {
          dispose();
        } catch {
          /* ignored */
        }
      }
      this.subscriptions.delete(instanceId);
    }
    this.sessions.delete(instanceId);
  }

  /** How many subscriptions this instance has right now (for the diagnostics) */
  subscriptionCount(instanceId: string): number {
    return this.subscriptions.get(instanceId)?.size ?? 0;
  }

  /**
     * Handles one request of a card.
     *
     * ── The authorisation happens on this layer ──
     *
     * | Permission | What is judged |
     * |---|---|
     * | `write` | the action id has to be in `permissions.write` → otherwise `denied` |
     * | `read` | **not judged here** — it is left to the read side (`TagsService`) to filter, because **"no permission" and "no such tag" look the same** (the existence is not leaked) |
     * | `none` | let it pass |
     */
  async handle(req: CardRequest): Promise<CardResponse> {
    const session = this.sessions.get(req.instanceId);
    if (session === undefined) {
      return { id: req.id, ok: false, reason: 'unknown_instance' };
    }
    const api = apiByName().get(req.method);
    if (api === undefined) {
      return { id: req.id, ok: false, reason: 'unknown_method' };
    }

    const args = (req.args ?? {}) as Record<string, unknown>;
    if (api.permission === 'write' || api.permission === 'workflow') {
      // **The two dimensions are judged separately** ✓ (contract §2.3 / §3.3 ✓ — a workflow id **must not be mixed into write** ✓)
      const allowed =
        api.permission === 'write' ? session.perms.write : (session.perms.workflows ?? []);
      const argName = api.scopeArg;
      // **`scopeArg` is empty → this layer does not judge it** ✓
      // (the argument of `workflows.status` is the **run id** ✓ — the ownership check is done **in the implementation** ✓)
      if (argName !== undefined) {
        const value = args[argName];
        if (typeof value !== 'string' || !allowed.includes(value)) {
          return { id: req.id, ok: false, reason: 'denied' };
        }
      }
    }

    const ctx: CardApiContext = {
      cardId: session.cardId,
      instanceId: session.instanceId,
      connectionId: session.connectionId,
      connection: this.deps.connectionInfo?.(session.connectionId) ?? null,
      services: session.services,
    };
    try {
      const value = await api.make(session.services)(ctx, args);
      // **A failure of the method has to be lifted onto the envelope**:
      // Contract §7.7 says "on failure it returns `{ ok: false, reason }`" —
      // this is the layer the card sees; it must not have to dig through `value` itself.
      if (isMethodFailure(value)) {
        return { id: req.id, ok: false, reason: value.reason };
      }
      return { id: req.id, ok: true, value };
    } catch (err) {
      return {
        id: req.id,
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * A failure returned by the method itself (`{ ok:false, reason }`).
 *
 * Contract §7.7: "no method throws: on failure it returns
 * `{ ok: false, reason }`" — so "the method failed" has to show up on the
 * **envelope** (`CardResponse.ok/reason`), otherwise the card only sees
 * `ok:true` plus a failure hidden inside `value`.
 *
 * ── The exception: **the result object of an action** ──
 *
 * The action result of contract `spec/04` §2.4 **has `ok` and `reason` of its
 * own**: `{ ok:false, reason:'denied', detail:'…' }` ✓ (the closed reason codes
 * of contract §2.4.1 ✓).
 *
 * Collapsing it into an envelope failure → **the reason code of the action
 * itself is gone** ✓ → the card only sees a vague "the method failed" ✗ →
 * **it cannot tell "no permission" from "wrong parameter"** ✗.
 *
 * → **A value that carries `verified` is a "result", not a "method-level
 * failure"**: in the result shape of the contract `verified` is a **mandatory**
 * field (it is there on success and on failure) ✓, while a method-level
 * failure (too many subscriptions, storage unavailable) does not have it ✓.
 */
function isMethodFailure(value: unknown): value is { ok: false; reason: string } {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { ok?: unknown; reason?: unknown; verified?: unknown };
  // **The result object** (contract spec/04 §2.4) → not collapsed
  if (typeof v.verified === 'boolean') return false;
  return v.ok === false && typeof v.reason === 'string';
}

/** The placeholder for the write side before it is wired up (**every call is refused**, not "pretending to succeed") */
function emptyActions(): CardServices['actions'] {
  return {
    invoke: (id: string) => ({ ok: false, reason: 'unknown_action', actionId: id }),
  };
}

/**
 * The placeholder for the workflow side before it is wired up (**everything is
 * refused** ✓).
 *
 * → **Not "let it pass"** ✗ — not being wired up means "the host does not know
 *   this workflow" ✓ → letting it pass = letting the card believe the
 *   workflow can run ✗.
 */
function emptyWorkflows(): CardServices['workflows'] {
  return {
    list: () => [],
    run: () => ({ ok: false, reason: 'denied' }),
    status: () => ({ ok: false, reason: 'denied' }),
  };
}

/** The placeholder for the storage before it is wired up (task 10 replaces it with the real one) */
function emptyStorage(): CardServices['storage'] {
  return {
    get: () => undefined,
    set: () => ({ ok: false, reason: 'not_available' }),
    remove: () => ({ ok: false, reason: 'not_available' }),
    keys: () => [],
    clear: () => ({ ok: false, reason: 'not_available' }),
  };
}

/** The read permission coverage (for the outside of the session) */
export { permissionCovers };

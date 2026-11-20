/**
 * The **single source of truth** of the card APIs.
 *
 * ── Why it has to be "one" ──
 *
 * If the host implementation and the bridge script injected into the card are
 * **written separately**, they will eventually drift apart — the card calls
 * `cockpit.tags.get` while the host only has `cockpit.tagsGet`,
 * the symptom is "the card says the method does not exist", and **nobody can
 * tell which side is wrong**.
 *
 * → The registry is the **only inventory**, and the bridge script is
 * **generated** from it ✓. Adding a new method touches this one place.
 *
 * ── `scopeArg`: which argument the permission check looks at ──
 *
 * A read permission is judged by **tag** (the pattern coverage of
 * `permissions.read`), a write permission by **action id**.
 * → Every method states which of its arguments is the one to be authorised,
 * so the host does not have to hard-code it per method name (that would be a
 * second set of rules).
 */
import type { ReasonCode, TagReading } from '../../shared/tag-reading';

/**
 * The **kind of permission** ✓.
 *
 * → `'workflow'` is the **fourth dimension** ✓ (contract §3.3 ✓):
 * a workflow **is not an action** ✓ (it is not in a board pack ✓), but it
 * **can just as well run commands on the machine of the user** ✗ → it
 * **must** have an authorisation surface of its own ✓ → **it must not be
 * mixed into `permissions.write`** ✓ (the semantics of that dimension are
 * "action id" ✓ — mixing them in would make it two sets of rules ✓).
 */
export type CardApiPermission = 'read' | 'write' | 'workflow' | 'none';

/** The context of one call (injected by the host) */
export interface CardApiContext {
  cardId: string;
  instanceId: string;
  connectionId: string | null;
  /** The identity of the current connection (**no connectionId** — contract §7.8: the word does not appear in the card code) */
  connection: { label: string; transport: string } | null;
  /** The session service (read side / storage / log / notification) — injected by the main side */
  services: CardServices;
}

/**
 * The capabilities the session has to provide (the **port**).
 *
 * The implementation lands with task 9; here only the shape is fixed — so
 * that the three layers "registry → handler → bridge script" depend on this
 * single interface and do not lock into each other.
 */
export interface CardServices {
  tags: {
    get(name: string): TagReading;
    list(): TagReading[];
    subscribe(name: string, subscriptionId: string): { ok: boolean; reason?: string };
    subscribePattern(pattern: string, subscriptionId: string): { ok: boolean; reason?: string };
    degradation(): { tag: string; reason: ReasonCode; detail: string }[];
  };
  storage: {
    get(key: string): unknown;
    set(key: string, value: unknown): { ok: boolean; reason?: string };
    remove(key: string): { ok: boolean; reason?: string };
    keys(): string[];
    clear(): { ok: boolean; reason?: string };
  };
  log(level: 'error' | 'warn' | 'info', message: string): void;
  /**
     * The write side (M6 · the write-side row of contract §7.7).
     *
     * **The permission is judged by action id** (the write permissions do not
     * use patterns, contract §2.3) — the session layer already has one check
     * (is this id in `permissions.write`), and here `invoke` goes through the
     * chain of the executor (encode → floor → authorisation → execute
     * → readback → audit).
     */
  actions: {
    invoke(id: string, params: Record<string, unknown>): Promise<unknown> | unknown;
  };
  /**
     * The workflow side (plan 7 · the three rows of contract `spec/03` §7.7 ✓).
     *
     * → **One per card** ✓ (made a factory ✓ — the same shape as `actions` ✓:
     *   the authorisation of a workflow is one per card ✓).
     * → **What is returned is the copy meant for the card** ✓ (the projection ✓
     *   — `workflow-view.ts` ✓).
     */
  workflows: {
    /** Lists the workflows (**only the ones the user has approved** ✓ — contract `05` §7.2 ✓) */
    list(): unknown;
    /** Starts a workflow (**the authorisation has already been judged** ✓ — one gate at the session layer and one at the host layer ✓) */
    run(id: string, inputs: Record<string, unknown>): Promise<unknown> | unknown;
    /** Looks at the state of a run (**a reduced projection** ✓) */
    status(runId: string): Promise<unknown> | unknown;
  };
}

export type CardApiHandler = (ctx: CardApiContext, args: Record<string, unknown>) => Promise<unknown> | unknown;

export interface CardApiDef {
  /** The full name, e.g. `tags.get`. The bridge splits it at the dot into a namespace */
  name: string;
  /**
     * **One sentence in plain words** (when this method is used ✓).
     *
     * → **It goes into the live SDK documentation** ✓ (`get_card_sdk_docs` ✓ —
     *   contract §2.3 ✓) — **the method name alone is not enough** ✓: an agent
     *   that sees `degradation()` **does not know when to use it** ✗.
     * → **It is written here, not in a hand-copied document** ✓ — **it lives and
     *   dies with the method** ✓ (when the method is deleted, the description
     *   goes with it ✓ → the documentation cannot drift ✓).
     */
  summary: string;
  permission: CardApiPermission;
  /** Which argument of `args` the permission check looks at (a tag name / an action id). The methods with `none` have none */
  scopeArg?: string;
  /** The order of the positional arguments (the bridge joins the actual arguments into an object in this order) */
  params: string[];
  /** May this card subscribe to it (a subscription is a **long-lived connection**, so it goes through the permission check) */
  subscribable?: boolean;

  /** Builds the handler of this method. It **receives the session**, so the implementation does not have to know the other modules of main */
  make: (services: CardServices) => CardApiHandler;
}

/**
 * The full set of card APIs (**what this build actually has**).
 *
 * **The write side `actions.invoke` exists since M6** (the write-side row of
 * contract §7.7).
 *
 * **There is still no `notify`** — the notification channel of the host is not
 * wired up yet.
 * Contract §7.7 says explicitly: "**a method this host does not implement**
 * answers `{ ok: false, reason: 'unknown_method' }`",
 * while `capabilities().methods` lists "**the methods this build actually
 * has**" — so **what is not implemented must not be listed** (listing it = the
 * card believes the notification went out, while nobody handles it).
 */
export function cardApis(): CardApiDef[] {
  return [
    {
      name: 'capabilities',
      summary: 'Ask the host: which methods can I call, which board am I connected to, and which tags are on it. **A card asks this first when it starts**.',
      permission: 'none',
      params: [],
      // **The methods this build actually has** (not the full set of the contract) — otherwise the card believes it can call a method that does not exist
      make: (services) => (ctx) => ({
        apiVersion: 'devboard/v1',
        methods: cardApis().map((api) => api.name),
        connection: ctx.connection,
        tags: services.tags.list().map((r) => r.tag),
      }),
    },
    {
      name: 'tags.get',
      summary: 'Read the current value and status of a tag. **Use this to read a number for a panel**.',
      permission: 'read',
      scopeArg: 'name',
      params: ['name'],
      make: (services) => (_ctx, args) => services.tags.get(String(args['name'])),
    },
    {
      name: 'tags.subscribe',
      summary: 'Subscribe to the changes of a tag. **Use it when the card has to follow a number** (subscribe first, then update the UI in the callback).',
      permission: 'read',
      scopeArg: 'name',
      params: ['name'],
      subscribable: true,
      // The **callback** of a subscription stays on the card side (a function cannot cross postMessage);
      // here only "which subscription id receives the pushes of which tag" is registered
      make: (services) => (_ctx, args) =>
        services.tags.subscribe(String(args['name']), String(args['subscriptionId'])),
    },
    {
      name: 'tags.subscribePattern',
      summary: 'Subscribe to a family of tags by pattern (such as `cpu.core.*.usage`). **Use it when you want to watch a group of numbers**.',
      permission: 'read',
      scopeArg: 'pattern',
      params: ['pattern'],
      subscribable: true,
      make: (services) => (_ctx, args) =>
        services.tags.subscribePattern(String(args['pattern']), String(args['subscriptionId'])),
    },
    {
      name: 'tags.list',
      summary: 'List every tag that is readable right now (with value and status). **Ask this first when you do not know which numbers exist**.',
      permission: 'read',
      params: [],
      make: (services) => () => services.tags.list(),
    },
    {
      name: 'degradation',
      summary: 'List the tags that **cannot be read**, together with the reason. **Use it when a panel has to show "this number is unavailable"**.',
      permission: 'none',
      params: [],
      make: (services) => () => services.tags.degradation(),
    },
    {
      name: 'actions.invoke',
      summary: 'Execute an action declared by the board pack (the write side). **Use it to change the state of the board** (subject to the danger grading).',
      permission: 'write',
      // **The write permission is judged by action id** (contract §2.3: the read permissions use patterns, the write ones do not —
      // a pattern widens the scope of the authorisation, which is convenient for reading and **dangerous** for writing)
      scopeArg: 'id',
      params: ['id', 'params'],
      // **What is returned is the result object** (contract spec/04 §2.4: `{ok, verified, readback, reason, audit_id}`)
      // → The session layer **does not collapse it into an envelope failure** (collapsing it would lose the result → the caller could not tell an action failure from a transport failure)
      make: (services) => (_ctx, args) =>
        services.actions.invoke(String(args['id']), (args['params'] ?? {}) as Record<string, unknown>),
    },
    {
      // **List the workflows** (contract §7.7: the permission is "none" — it only lists the ones **the user has approved** ✓)
      name: 'workflows.list',
      summary: 'List the workflows the user has approved (only id / name / input declarations).',
      permission: 'read',
      params: [],
      make: (services) => () => services.workflows.list(),
    },
    {
      // **Start a workflow** (contract §7.7: the write side ✓ — the permission looks at the **workflow id** ✓)
      name: 'workflows.run',
      summary: 'Run a workflow, **returning the run_id immediately**; poll `workflows.status` for progress.',
      permission: 'workflow',
      scopeArg: 'id',
      params: ['id', 'inputs'],
      make: (services) => (_ctx, args) =>
        services.workflows.run(
          String(args['id']),
          (args['inputs'] ?? {}) as Record<string, unknown>,
        ),
    },
    {
      /**
             * **Look at the state of a run** (contract §7.7: the read side ✓).
             *
             * → **`scopeArg` is empty** ✓: the argument of the method is the **run
             *   id** ✓, while the permission has to look at **which workflow this
             *   run belongs to** ✓ — and that mapping **only the host knows** ✓
             *   → so the ownership check is done **in the implementation** ✓ (this
             *   layer of the session does not judge it ✓).
             */
      name: 'workflows.status',
      summary: 'Inspect the status and stage timeline of a run.',
      permission: 'workflow',
      params: ['runId'],
      make: (services) => (_ctx, args) => services.workflows.status(String(args['runId'])),
    },
    {
      name: 'storage.get',
      summary: 'Read the persistent storage of this card (**one store per card**).',
      permission: 'none',
      params: ['key'],
      make: (services) => (_ctx, args) => services.storage.get(String(args['key'])),
    },
    {
      name: 'storage.set',
      summary: 'Write to the persistent storage of this card.',
      permission: 'none',
      params: ['key', 'value'],
      make: (services) => (_ctx, args) =>
        services.storage.set(String(args['key']), args['value']),
    },
    {
      name: 'storage.remove',
      summary: 'Delete one storage key.',
      permission: 'none',
      params: ['key'],
      make: (services) => (_ctx, args) => services.storage.remove(String(args['key'])),
    },
    {
      name: 'storage.keys',
      summary: 'List the storage keys of this card.',
      permission: 'none',
      params: [],
      make: (services) => () => services.storage.keys(),
    },
    {
      name: 'storage.clear',
      summary: 'Clear the storage of this card.',
      permission: 'none',
      params: [],
      make: (services) => () => services.storage.clear(),
    },
    {
      name: 'log',
      summary: 'Write one entry into the runtime log of this card (**the eyes of the agent for self-testing can see it**).',
      permission: 'none',
      params: ['level', 'message'],
      make: (services) => (_ctx, args) => {
        const level = args['level'];
        const level2 =
          level === 'error' || level === 'warn' || level === 'info' ? level : 'info';
        services.log(level2, String(args['message'] ?? ''));
        return { ok: true };
      },
    },
  ];
}

/** Looks it up by the full name (used when the host dispatches) */
export function apiByName(): Map<string, CardApiDef> {
  return new Map(cardApis().map((api) => [api.name, api]));
}

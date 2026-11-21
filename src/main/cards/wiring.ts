import { CardRegistry } from './registry';
import type { CardRoot } from './roots';
import { CardSessionManager, type RuntimeReader } from './session';
import type { CardServices } from './api-registry';
import { CardStorage } from './storage';
import { CardRuntimeLog } from './runtime-log';
import { createCardProtocol } from './protocol';
import { bridgeScriptFor } from './bridge-script';
import { cspScriptFor } from './csp-script';
import { LayoutStore } from './layout';
import { cardApis } from './api-registry';
import { parseManifest } from './manifest';
import { validateCard } from './validate';
import { aliasVars, themeCss } from '../../shared/theme/map';
import { baseStyleBlock } from '../../shared/theme/base-css';
import type { CardPermissions } from './permissions';
import type { CardInstanceInfo, CardRequest, CardResponse } from '../../shared/ipc-contract';
import { normalizeLayout } from '../../shared/layout';
import type { LayoutState } from '../../shared/layout';
import type { ThemeName } from '../../shared/theme/seed';
import { IPC } from '../../shared/ipc-contract';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { mimeFor } from './paths';

/**
 * The **wiring** of the card host: the registry, the session, the protocol, the
 * storage and the log are connected into one thing.
 *
 * ── Why it is a module of its own ──
 *
 * `main/index.ts` is the entry point of Electron (window, IPC, title bar),
 * **it must not grow into a wiring diagram of the cards**. Here "how a card
 * comes alive" is collected in one place, and the entry point only calls three
 * lines:
 *
 * ```ts
 * const cards = createCardWiring({ … });
 * protocol.handle('cockpit', cards.protocol);
 * handle(IPC.cardsList, () => cards.list());
 * ```
 */
export interface CardWiringDeps {
  /** The two roots of the card directories */
  roots: CardRoot[];
  /** The source of the readings */
  runtime: RuntimeReader;
  /** The push channel (main → page → card) */
  broadcast: (channel: string, ...args: unknown[]) => void;
  /** The current connection (in v1 there is only one) */
  currentConnectionId: () => string | null;
  /** The identity of the current connection (for `capabilities()`) */
  connectionInfo?: (connectionId: string | null) => { label: string; transport: string } | null;
  /** The permission set of this card (manifest + authorised) */
  permsFor: (cardId: string) => CardPermissions;
  /**
     * The workflow ids declared in the host (rule 14 ✓).
     *
     * → `null` = **offline** (it cannot be looked up ✓) → rule 14 is degraded
     *   into a **warning** ✓.
     */
  availableWorkflows?: () => string[] | null;
  /**
     * The **action ids** of the current board pack (rule 5 ✓).
     *
     * → `null` = **offline** (it cannot be looked up ✓) → rule 5 is degraded into
     *   a **warning** ✓
     * → **When it is not `null` the real table is given** ✓ — **the same reading
     *   as the MCP `validate_card`** ✓ (both routes have to give the same
     *   answer ✓ — otherwise "one product, two answers" ✗).
     */
  availableActions?: () => string[] | null;
  /**
     * The write side of each card (the action executor, M6).
     *
     * Made a **factory**: the executor has to hold the **authorisation of this
     * card**, and the authorisation is one per card.
     */
  actionsFor?: (cardId: string) => CardServices['actions'];
  /**
     * The **workflow side** of each card (plan 7 ✓).
     *
     * Made a **factory**: the authorisation of a workflow is one per card ✓ (the
     * same shape as `actionsFor` ✓).
     */
  workflowsFor?: (cardId: string) => CardServices['workflows'];
  bootLogFor?: (cardId: string) => CardServices['bootLog'];
  /** The root directory of the storage */
  storageDir: string;
  /** The layout file (**the book of the host**: which card sits in which cell) */
  layoutFile: string;
  /** The build output directory of the shell (`cockpit://app/` is served from here) */
  shellDir?: string;
  /** The CSP of the shell (for the production build; **in development Vite is used, not it**) */
  shellCsp?: string;
  /** The current skin */
  theme?: () => ThemeName;
  now?: () => number;
}

export interface CardWiring {
  registry: CardRegistry;
  sessions: CardSessionManager;
  storage: CardStorage;
  log: CardRuntimeLog;
  /** The handler of `cockpit://` */
  protocol: (request: Request) => Response;
  /** The installed cards (the page renders the card area from them) */
  list: () => CardInstanceInfo[];
  /** One request of a card */
  handleRequest: (req: CardRequest) => Promise<CardResponse>;
  /** Reads the layout */
  layoutGet: () => LayoutState;
  /** Stores the layout */
  layoutSet: (state: LayoutState) => void;
  /**
   * **The board changed** ✓ → the cells follow ✓.
   *
   * → Without it the cards of the main area **disappear** when the board is
   *   switched ✓ (the cells are bound to the old connection id ✓ — found on
   *   2026-11-21 ✓).
   */
  layoutRebind: (from: string | null, to: string | null) => void;
  /** Discovers the cards again (hot plug) */
  refresh: () => void;
  /** Attributes a CSP violation to the runtime log of a card */
  captureCspViolation: (details: { message: string; sourceUrl: string }) => string | null;
  /** Stops the watching */
  stop: () => void;
}

export function createCardWiring(deps: CardWiringDeps): CardWiring {
  const theme = deps.theme ?? ((): ThemeName => 'dark');
  const now = deps.now ?? (() => Date.now());

  const registry = new CardRegistry({
    roots: deps.roots,
    loadManifest: (dir) => loadManifestOf(dir),
    validate: (manifest, dir) => {
      const result = validateManifest(manifest, dir, registry, deps.availableWorkflows, deps.availableActions);
      return [...result.errors, ...result.warnings];
    },
  });

  const storage = new CardStorage({ dir: deps.storageDir });
  const log = new CardRuntimeLog({ now });
  const layout = new LayoutStore({ file: deps.layoutFile, now });

  /**
   * **The connection the cards are on** ✓ (the last one that was seen ✓).
   *
   * → The cells of the work area are bound to `(cardId, connectionId)` ✓
   *   (contract `spec/03` §7 ✓) → the instances of the cards carry the
   *   **current** connection ✓ → when the connection changes ✓ the cells have
   *   to follow it ✓ (**otherwise the cards disappear from the main area** ✗
   *   — the cell carries the old connection ✓ and the instance the new one ✓
   *   → no key matches ✓).
   * → It happens **here** ✓ because this is the place where the current
   *   connection is read ✓ → **every** path that changes it comes through
   *   here ✓ (the board connects on its own at start ✓ · the runtime tries
   *   another channel ✓ · the person switches the board ✓).
   */
  let lastConnectionId: string | null = null;
  /** card id → the current instance id (used to notice "the instance changed") */
  const instanceByCard = new Map<string, string>();

  const sessions = new CardSessionManager({
    runtime: deps.runtime,
    permsFor: deps.permsFor,
    now,
    push: (instanceId, payload) => {
      deps.broadcast(IPC.cardsEvent, instanceId, payload);
    },
    storageFor: (cardId) => ({
      get: (key) => storage.get(cardId, key),
      set: (key, value) => storage.set(cardId, key, value),
      remove: (key) => storage.remove(cardId, key),
      keys: () => storage.keys(cardId),
      clear: () => storage.clear(cardId),
    }),
    logFor: (cardId) => (level, message) => {
      log.append(cardId, { source: 'card', level, message });
    },
    ...(deps.actionsFor === undefined ? {} : { actionsFor: deps.actionsFor }),
    ...(deps.workflowsFor === undefined ? {} : { workflowsFor: deps.workflowsFor }),
    ...(deps.bootLogFor === undefined ? {} : { bootLogFor: deps.bootLogFor }),
    connectionInfo: deps.connectionInfo,
  });

  const cardProtocol = createCardProtocol({
    dirOfInstance: (instanceId) => registry.dirOfInstance(instanceId),
    entryOfInstance: (instanceId) => registry.entryOfInstance(instanceId) ?? 'index.html',
    bridgeScript: (instanceId) => bridgeScriptFor(cardApis(), instanceId),
    cspScript: (instanceId) => cspScriptFor(instanceId),
    themeStyle: () => `${themeCss(theme(), ':root')}\n${baseStyleBlock()}`,
  });

  /**
     * The handler of `cockpit://`: `app` is the shell, `card` is a card.
     *
     * **Why the shell goes through the protocol as well**: `'self'` on `file://`
     * **matches nothing at all** (the origin of a local scheme is opaque) — the
     * shell needs a real origin to have a CSP.
     * → The shell of the production build is served from `cockpit://app/` ✓
     */
  const protocol = (request: Request): Response => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('not found', { status: 404 });
    }
    if (url.hostname === 'app') return serveShell(url, deps.shellDir, deps.shellCsp);
    return cardProtocol(request);
  };

  return {
    registry,
    sessions,
    storage,
    log,
    protocol,
    list: () => {
      const cards = registry.cards();
      const connectionId = deps.currentConnectionId();
      // → **The connection changed** ✓ → the cells of the work area follow it ✓
      //   (without this the cards disappear from the main area ✗ — found on
      //   2026-11-22 ✓: the re-binding only happened when the person switched
      //   the board by hand ✗, and the board that connects **on its own** at
      //   start ✗ — the usual case ✓ — left the cells on the old connection ✗).
      if (connectionId !== lastConnectionId) {
        layout.rebind(lastConnectionId, connectionId);
        lastConnectionId = connectionId;
      }
      const out: CardInstanceInfo[] = [];
      for (const card of cards) {
        const { instanceId, url } = registry.instanceFor(card.cardId, connectionId);
        const previous = instanceByCard.get(card.cardId);
        // **The instance changed (the connection changed) → the old session has to be closed**:
        // its subscriptions are still attached to the runtime; without closing it they can never be released (RF-4)
        if (previous !== undefined && previous !== instanceId) {
          sessions.close(previous);
        }
        instanceByCard.set(card.cardId, instanceId);
        log.bind(instanceId, card.cardId);
        out.push({
          instanceId,
          cardId: card.cardId,
          url,
          connectionId,
          degraded: card.issues.some((i) => i.severity === 'error'),
          // **The default size the card declares for itself** (the layout.w/h of the manifest) —
          // the page uses it when it places the card in the main area (the wish of the author, the host can read the manifest)
          ...(card.manifest.layout === undefined
            ? {}
            : {
                layout: {
                  w: card.manifest.layout.w ?? 3,
                  h: card.manifest.layout.h ?? 2,
                  ...(card.manifest.layout.min_w === undefined
                    ? {}
                    : { min_w: card.manifest.layout.min_w }),
                  ...(card.manifest.layout.min_h === undefined
                    ? {}
                    : { min_h: card.manifest.layout.min_h }),
                },
              }),
        });
      }
      // The card is gone (it was deleted) → its session has to be closed too
      const alive = new Set(cards.map((c) => c.cardId));
      for (const [cardId, instanceId] of [...instanceByCard]) {
        if (!alive.has(cardId)) {
          sessions.close(instanceId);
          instanceByCard.delete(cardId);
        }
      }
      return out;
    },
    handleRequest: (req) => sessions.handle(req),
    // ── The layout = **which cards are placed in the main area** ──
    //
    // v3: one layout, no views. **The main area is empty by default** — the user clicks a card in the card library
    // of the second level on the left to place it (only the placed cards are in `units`).
    //
    // → Only two jobs are left for the host:
    //   ① read it (the v1/v2 files are still readable ✓ in `normalizeLayout`)
    //   ② when storing, **do not lose the cells of the cards that are not installed** (a card that is uninstalled and installed again keeps its position)
    layoutGet: () => layout.get(),
    layoutRebind: (from, to) => layout.rebind(from, to),
    layoutSet: (input) => {
      const connectionId = deps.currentConnectionId();
      const installed = new Set(
        registry.cards().map((c) => layoutKey(c.cardId, connectionId)),
      );
      const previous = layout.get();
      const state = normalizeLayout(input, now());
      const incoming = new Set(state.units.map((u) => layoutKey(u.cardId, u.connectionId)));
      // **A card that is not installed** (uninstalled but the user placed it) → keep its cell, so the position is still there when it comes back
      const kept = previous.units.filter(
        (u) => !installed.has(layoutKey(u.cardId, u.connectionId)) && !incoming.has(layoutKey(u.cardId, u.connectionId)),
      );
      layout.set({ ...state, units: [...kept, ...state.units], updatedAt: now() });
    },
    refresh: () => {
      registry.refresh();
    },
    captureCspViolation: (details) => log.attributeCspViolation(details),
    stop: () => undefined,
  };
}

/* ── Two small helpers ── */

/** The key of a layout unit (`(cardId, connectionId)`) */
function layoutKey(cardId: string, connectionId: string | null): string {
  return `${cardId}::${connectionId ?? ''}`;
}

/** The static files of the shell (`cockpit://app/…`) */
function serveShell(url: URL, shellDir: string | undefined, shellCsp: string | undefined): Response {
  if (shellDir === undefined) return new Response('not found', { status: 404 });
  const rel = url.pathname === '/' || url.pathname === '' ? 'index.html' : url.pathname.slice(1);
  // **The directory of the shell has to be protected against traversal as well** (it serves the build output, not a card)
  const resolved = resolve(shellDir, rel);
  if (resolved !== shellDir && !resolved.startsWith(shellDir + sep)) {
    return new Response('forbidden', { status: 403 });
  }
  if (!existsSync(resolved)) return new Response('not found', { status: 404 });
  const body = readFileSync(resolved);
  const headers: Record<string, string> = { 'Content-Type': mimeFor(resolved) };
  if (shellCsp !== undefined) headers['Content-Security-Policy'] = shellCsp;
  return new Response(body, { status: 200, headers });
}

function loadManifestOf(dir: string): ReturnType<typeof parseManifest> {
  const raw = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as unknown;
  return parseManifest(raw, dir);
}

function validateManifest(
  manifest: Parameters<typeof validateCard>[0],
  dir: string,
  registry: CardRegistry,
  availableWorkflows?: () => string[] | null,
  availableActions?: () => string[] | null,
): ReturnType<typeof validateCard> {
  return validateCard(manifest, {
    // **Offline**: the board is unreachable → the existence of the actions and the tags is "not verified", not "invalid"
    availableTags: null,
    // **The action table** ✓ — **do not hard-code `null` again** ✓ (fixed on 2026-11-19 ✓)
    //
    // → Before it was **always** `null` ✓ → **rule 5 always took the "not verified" branch** ✓ →
    //   **every card that can write to the board was "degraded" as soon as it was installed** ⚠️
    // → while the MCP `validate_card` route gives the **real table** ✓ → **one product, two answers** ✗
    // → **invisible during development** ✗ (that route has the real table ✓) → **only exposed after the installation** ✗
    //
    // → **Once a board pack is bound the real table is given** ✓ (`null` only means **truly offline** ✓)
    availableActions: availableActions?.() ?? null,
    // **The host knows the workflow ids itself** ✓ (unlike the board, they are only found out when it is connected ✓)
    availableWorkflows: availableWorkflows?.() ?? null,
    // Rule 2 compares the **id of the manifest**, and it **has to exclude itself**:
    // Comparing the directory name means that a card **that changes one file** (a hot update always triggers one refresh)
    // judges itself a "duplicate" in the second refresh → the card becomes degraded for no reason.
    installedCardIds: registry
      .cards()
      .filter((c) => c.dir !== dir)
      .map((c) => c.manifest.id),
    fileExists: (rel) => existsSync(join(dir, rel)),
  });
}

/** When the theme changes, the new alias values are pushed to all the cards (the iframe is not reloaded) */
export function themePush(theme: ThemeName): Record<string, string> {
  return aliasVars(theme);
}

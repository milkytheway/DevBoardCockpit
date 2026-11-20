import type { PermissionStore } from '../permissions/policy';
import { cardState, type CardState } from '../cards/state';
import { validateCardAt } from '../cards/validate-at';
import type { McpCardEntry, McpHostDeps, McpValidateResult } from '../mcp/host';
import type { CardRegistry } from '../cards/registry';
import type { CardRuntimeLog } from '../cards/runtime-log';
import type { TagRuntime } from '../tags/runtime';
import type { ConnectionProfile } from '../profiles/schema';
import type { ConnectionCapabilities } from '../../shared/ipc-contract';
import type { TerminalManager } from '../terminal/manager';
import type { LayoutState } from '../../shared/layout';
import { capabilitiesFor } from '../hal/capabilities';
import type { AgentActionDeps } from './action-tools';

/**
 * **Shapes the host into what the MCP layer expects** ✓.
 *
 * ── Why this layer exists ──
 *
 * → **The MCP layer must not know how the host is organised internally** ✓
 *   (it only knows the narrow interfaces of `McpHostDeps` ✓).
 * → **All the decisions are on the host side** ✓ — the MCP layer **only
 *   forwards and projects** ✓ (contract §6 ✓).
 *
 * ── The criterion of `connected` (**both have to hold** ✓) ──
 *
 * ① It is **the connection of the current tag runtime**, **and** the state of
 *    the runtime is `running` ✓
 *    — **looking only at "the runtime remembers this profile" is not enough**
 *      ✓: when it cannot connect (`error` ✓) and when it has stopped (`idle`
 *      ✓) **that id is still there** ✓ → it would report `true` wrongly ✗.
 * ② **Or** it **has a terminal session open** ✓.
 */
export interface McpHostWiring {
  /** The list of the connection profiles */
  listProfiles: () => ConnectionProfile[];
  /** The tag runtime */
  runtime: TagRuntime;
  /** The terminal manager (**the live sessions** ✓) */
  terminal: TerminalManager;
  /** The card registry */
  cards: CardRegistry;
  /** The runtime log of the cards */
  cardLog: CardRuntimeLog;
  /** Reads the layout (**the book of the host** ✓ — the same one as on the card side ✓) */
  layoutGet: () => LayoutState;
  /** Stores the layout (**the same book** ✓ — no second set of books ✓) */
  layoutSet: (state: LayoutState) => void;
  /** The action execution dependencies of the agent (**the same executor as the card side** ✓) */
  agentActions: AgentActionDeps;
  /** The user card root (**the cards are installed here** ✓) */
  cardsRoot?: string;
  /** The authorisation ledger */
  /** The consent queue (**the ones waiting for a human approval** ✓) */
  /** The ids of the built-in cards (**a built-in card may not be deleted** ✓) */
  builtinCardIds?: string[];
  /** **The unified permission area** (the table of the settings page ✓ · ADR-D47 ✓) */
  permissions?: PermissionStore;
}

/** Assembles the host dependencies of the MCP layer ✓ */
export function buildMcpHost(wiring: McpHostWiring): McpHostDeps {
  const { runtime, terminal, cards, cardLog } = wiring;

  return {
    pack: () => runtime.packView,
    readings: () => runtime.readings(),
    history: (tag, n) => runtime.sampleHistory(tag, n),
    refreshTag: async (tag) => {
      // **Sample it in a directed way once first** ✓ (contract §2.1 ✓) — it does not blow up when it cannot be sampled ✓ (**no such tag means no such tag** ✓)
      await runtime.sampleTag(tag);
    },
    profiles: wiring.listProfiles,
    capabilities: (profile: ConnectionProfile): ConnectionCapabilities =>
      capabilitiesFor(profile),
    connected: (profileId: string): boolean => {
      // ① **The connection of the current runtime** ✓ — **and the state is `running`** ✓
      const status = runtime.status;
      if (status.state === 'running' && status.profileId === profileId) return true;
      // ② **Or a terminal session is open** ✓
      return terminal.liveProfileIds().includes(profileId);
    },
    // **Which connection the current runtime uses** ✓ (**`null` when there is none** ✓ — no guessing ✓)
    currentProfileId: (): string | null => runtime.status.profileId ?? null,
    cards: (): McpCardEntry[] =>
      cards.cards().map((card) => {
        const state: CardState = cardState({
          cardId: card.cardId,
          dir: card.dir,
          manifest: card.manifest,
          issues: card.issues,
          pack: runtime.packView,
          readings: runtime.readings(),
        });
        return {
          cardId: card.cardId,
          dir: card.dir,
          manifest: card.manifest,
          issues: card.issues,
          state: {
            installed_at: state.installed_at,
            status: state.status,
            degraded: state.degraded,
            missing_tags: state.missing_tags,
            unreadable_tags: state.unreadable_tags,
          },
        };
      }),
    cardDir: (cardId: string) => cards.dirOf(cardId),
    validateCard: (path: string): McpValidateResult =>
      validateCardAt({
        dir: path,
        pack: runtime.packView,
        readings: runtime.readings(),
        actionIds: runtime.packView?.actions ?? [],
        // **Rule 2 compares the id of the manifest** ✓, **and it has to exclude itself** ✓
        installedCardIds: cards
          .cards()
          .filter((c) => c.dir !== path)
          .map((c) => c.manifest.id),
      }),
    cardLog: (cardId: string) => cardLog.read(cardId),
    layout: (): LayoutState => wiring.layoutGet(),
    saveLayout: (state: LayoutState) => wiring.layoutSet(state),
    // **The action execution of the agent** ✓ — **the same executor is reused** ✓ (the card side uses the same one ✓)
    actions: wiring.agentActions,
    // **Installing and uninstalling a card** ✓ (contract §2.3 ✓)
    ...(wiring.cardsRoot === undefined
      ? {}
      : {
          cardTools: {
            cardsRoot: wiring.cardsRoot,
            registry: cards,
            packActions: () => runtime.actionDefs,
            ...(wiring.builtinCardIds === undefined ? {} : { builtinIds: wiring.builtinCardIds }),
          },
        }),
  };
}

import type { TagReading } from '../../shared/tag-reading';
import type { ConnectionProfile } from '../profiles/schema';
import type { ConnectionCapabilities } from '../../shared/ipc-contract';
import type { PackView } from '../tags/pack-view';
import type { CardManifest } from '../cards/manifest';
import type { CardIssue } from '../cards/validate';
import type { CardLogEntry } from '../cards/runtime-log';
import type { LayoutState } from '../../shared/layout';
import type { AgentActionDeps } from './action-tools';
import type { CardToolDeps } from './card-tools';

/**
 * The **host dependencies the MCP layer needs** ✓.
 *
 * ── It has the shape of a "thin wrapper" ──
 *
 * The MCP layer **only forwards and projects** ✓ — **it holds no business
 * decision at all** ✓
 * (the decisions are on the host side ✓ — and it **shares the same set** with
 * the card side ✓).
 *
 * → **Why narrow interfaces instead of handing over the host objects** ✓:
 *   the two sides **have different shapes** ✓ (the card side does not give
 *   the `audit_id` ✓ · the agent side does ✓) →
 *   **handing over the same object means leaking the shape of one side to the
 *   other** ✗.
 *
 * → **Every dependency is "one function" or "a few fields"** ✓ — the internal
 *   objects are not handed over ✓.
 */
export interface McpHostDeps {
  /** The redacted view of the current board pack (**`null` when there is none** ✓) */
  pack: () => PackView | null;
  /** The current readings (**all of them** ✓ — the tools filter themselves ✓) */
  readings: () => TagReading[];
  /** The last n samples (**for `sample_tag` and `describe_tag.history` ✓**) */
  history: (tag: string, n: number) => TagSampleLike[];
  /** Samples it in a directed way once (**`sample_tag` has to sample first** ✓) */
  refreshTag: (tag: string) => Promise<void>;

  /** The list of the connection profiles */
  profiles: () => ConnectionProfile[];
  /** The connection-level capability bits of this profile */
  capabilities: (profile: ConnectionProfile) => ConnectionCapabilities;
  /** **Does this profile have a live connection right now** ✓ */
  connected: (profileId: string) => boolean;
  /**
     * **Which connection the current runtime uses** ✓ (**`null` when there is
     * none** ✓).
     *
     * → **The `current` of `list_connections` relies on it** ✓ (contract
     *   `spec/04` §2.1 ✓)
     * → **`connected` is a different criterion** ✓: **a terminal session that is
     *   open** also counts as `connected` ✓
     *   but it is **not the connection of the runtime** ✓ → **two different
     *   things** ✓ (they are not mixed ✓).
     */
  currentProfileId: () => string | null;

  /** The installed cards */
  cards: () => McpCardEntry[];
  /** The absolute path of a card directory (**for `validate_card`** ✓) */
  cardDir: (cardId: string) => string | null;
  /**
     * **Validates a card directory** (**it does not install it** ✓ — contract
     * §2.3 ✓).
     *
     * → **The decision is made on the host side** ✓ (`cards/validate.ts` ✓ —
     *   the rules are the 14 rules of contract §9 ✓).
     */
  validateCard: (path: string) => McpValidateResult;
  /** The runtime log of the cards */
  cardLog: (cardId: string) => CardLogEntry[];
  /** The current layout */
  layout: () => LayoutState;
  /** Saves the layout */
  saveLayout: (state: LayoutState) => void;
  /**
     * The **action execution dependencies of the agent** (**the write side** ✓ —
     *   contract §2.4 ✓).
     *
     * → **The same executor is reused** ✓ (the card side uses the same one ✓ —
     *   there is only one chain of seven steps ✓).
     */
  actions: AgentActionDeps;
  /** Installing and uninstalling a card (**contract §2.3** ✓) — **without them these two tools are not offered** ✓ */
  cardTools?: CardToolDeps;
}

/** One sample (**the same shape as the one of the `TagStore`** ✓ — the host side changing the type does not change the shape ✓) */
export interface TagSampleLike {
  value: number | string | boolean | null;
  unit: string;
  status: TagReading['status'];
  at: number;
}

/** The card entry the host gives to the MCP (**the state is already computed** ✓ — the decision is made on the host side ✓) */
export interface McpCardEntry {
  /** card id = the name of the directory ✓ */
  cardId: string;
  dir: string;
  manifest: CardManifest;
  issues: CardIssue[];
  /** The state of this card on the current board (**computed on the host side** ✓) */
  state: {
    installed_at: number;
    status: 'ok' | 'degraded' | 'invalid';
    degraded: boolean;
    missing_tags: string[];
    unreadable_tags: string[];
  };
}

/**
 * The **result of `validate_card`** (contract `spec/04` §2.3 ✓ · ADR-D40 ✓).
 *
 * → **`resolved.tags` / `resolved.actions` are "declared ∩ currently
 *   available"** ✓
 *   (**not** the declared values ✓ — what the agent wants to know is "what
 *   this card can really bind" ✓).
 */
export interface McpValidateResult {
  ok: boolean;
  errors: { severity: string; rule: number; path: string; message: string }[];
  warnings: { severity: string; rule: number; path: string; message: string }[];
  resolved: {
    /** The tags it reads that are **readable on the current board** (**the concrete names** ✓) */
    tags: string[];
    /** The action ids it writes that **really exist in the current board pack** ✓ */
    actions: string[];
    /** The cell size that came out of the parsing (**`null` when there is no layout** ✓) */
    layout: { w: number; h: number; min_w: number; min_h: number } | null;
    /** The tags it reads that are **not readable right now** ✓ */
    missing_tags: string[];
    /** The action ids it writes that are **not in the current board pack** ✓ */
    missing_actions: string[];
  };
}

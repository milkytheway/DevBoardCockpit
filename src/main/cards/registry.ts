import { randomUUID } from 'node:crypto';
import type { CardManifest } from './manifest';
import type { CardIssue } from './validate';
import { listCardDirs, type CardRoot } from './roots';
import { cardRevision } from './revision';

/**
 * The card registry: **which cards are installed**, and what the address of
 * every instance is.
 *
 * ── "When it is invalid, keep the previous version" ──
 *
 * An agent writes a card and stops halfway; the manifest may be broken.
 * At that moment the card **must not be taken off the workbench** — the
 * previous version of it was still good, and taking it off = the user watches
 * the instrument they just built disappear.
 * → Keep the previous version and **record the problem** so it can be shown
 * (`issues`).
 *
 * ── What an instance is ──
 *
 * An **instance = one card + one connection** (contract §7.8: the connection
 * context is an implicit scope). The same card on two connections → two
 * instances → two iframes → each of them looks at its own board.
 */
export interface DiscoveredCard {
  cardId: string;
  dir: string;
  manifest: CardManifest;
  /** The problems of this card (`severity` separates "invalid" from "not verified") */
  issues: CardIssue[];
  rootKind: 'builtin' | 'user';
  /**
     * The **content fingerprint** of a card directory (a change = the card code
     * changed).
     *
     * It goes into the instance id → the URL changes → the **iframe is rebuilt**
     * → only then does "edit a file and it hot-reloads" hold.
     */
  revision: string;
}

export interface CardRegistryDeps {
  roots: CardRoot[];
  /** Reads and parses the manifest of a card directory (**a parse failure throws**) */
  loadManifest: (dir: string) => CardManifest;
  /** Validates a manifest and returns the list of problems */
  validate: (manifest: CardManifest, dir: string) => CardIssue[];
}

export class CardRegistry {
  /** The current state of every card */
  private readonly byCard = new Map<string, DiscoveredCard>();
  /** `(card id | connection id) → instance id`. **Stable**: the same pair always gives the same instance */
  private readonly instances = new Map<string, string>();
  /** instance id → card id (the protocol handler looks the card directory up through it) */
  private readonly instanceCards = new Map<string, string>();

  constructor(private readonly deps: CardRegistryDeps) {}

  /**
     * Scans the card directories again.
     *
     * @returns the current list of cards
     */
  refresh(): DiscoveredCard[] {
    const found = listCardDirs(this.deps.roots);
    const seen = new Set<string>();

    for (const entry of found) {
      seen.add(entry.cardId);
      let manifest: CardManifest;
      try {
        manifest = this.deps.loadManifest(entry.dir);
      } catch (err) {
        // **The manifest cannot be read at all** (broken JSON / an unknown field):
        // the same "keep the previous version", and the problem is recorded.
        const issue: CardIssue = {
          severity: 'error',
          rule: 10,
          path: 'manifest.json',
          message: `the manifest cannot be read: ${err instanceof Error ? err.message : String(err)}`,
        };
        const previous = this.byCard.get(entry.cardId);
        if (previous !== undefined) {
          this.byCard.set(entry.cardId, { ...previous, issues: [issue] });
        }
        continue;
      }

      const issues = this.deps.validate(manifest, entry.dir);
      const blocking = issues.filter((i) => i.severity === 'error');
      if (blocking.length > 0) {
        // **Invalid → keep the previous version** (both the manifest and the issues leave a trace)
        const previous = this.byCard.get(entry.cardId);
        if (previous !== undefined) {
          this.byCard.set(entry.cardId, { ...previous, issues });
        } else {
          // It was already broken when it was installed the first time → this card **does not enter the workbench**,
          // but the problem still has to be said somewhere (it is visible in the diagnostic report)
          this.byCard.set(entry.cardId, {
            cardId: entry.cardId,
            dir: entry.dir,
            manifest,
            issues,
            rootKind: entry.rootKind,
            revision: cardRevision(entry.dir),
          });
        }
        continue;
      }

      this.byCard.set(entry.cardId, {
        cardId: entry.cardId,
        dir: entry.dir,
        manifest,
        issues,
        rootKind: entry.rootKind,
        // **The content changed → the fingerprint changed → the instance id changed → the iframe is rebuilt**
        revision: cardRevision(entry.dir),
      });
    }

    // A card whose directory is gone → it is withdrawn from the list (the files were deleted)
    for (const cardId of [...this.byCard.keys()]) {
      if (!seen.has(cardId)) this.byCard.delete(cardId);
    }

    return this.cards();
  }

  /** The current list of cards */
  cards(): DiscoveredCard[] {
    return [...this.byCard.values()].sort((a, b) => a.cardId.localeCompare(b.cardId));
  }

  /** The directory of a card. **`null` when it is not installed** (no guessing) */
  dirOf(cardId: string): string | null {
    return this.byCard.get(cardId)?.dir ?? null;
  }

  /**
     * Fetches (or allocates) an instance.
     *
     * ── The instance key **carries the content fingerprint** ──
     *
     * The instance id goes into the URL of the iframe; **as long as the URL does
     * not change, the browser does not reload** — the card would keep running the
     * old code. So "the content of the card changed" has to show up in the
     * instance id: the fingerprint changes → the key changes → a **new instance
     * id** → the URL changes → the React key changes → the iframe is rebuilt ✓
     * (the old session is closed with it, so the subscriptions do not leak — see
     * `list()` in `wiring.ts`)
     *
     * @param connectionId which connection this card looks at. `null` = there is
     *        no connection context yet
     */
  instanceFor(cardId: string, connectionId: string | null): { instanceId: string; url: string } {
    const revision = this.byCard.get(cardId)?.revision ?? '';
    const key = `${cardId} ${connectionId ?? ''} ${revision}`;
    let instanceId = this.instances.get(key);
    if (instanceId === undefined) {
      instanceId = randomUUID();
      this.instances.set(key, instanceId);
    }
    this.instanceCards.set(instanceId, cardId);
    const card = this.byCard.get(cardId);
    const entry = card?.manifest.entry ?? 'index.html';
    return { instanceId, url: `cockpit://card/${instanceId}/${entry}` };
  }

  /** Which card this instance is (**`null` when it was never registered**) */
  cardOfInstance(instanceId: string): string | null {
    return this.instanceCards.get(instanceId) ?? null;
  }

  /** The card directory of this instance (the protocol handler serves the resources through it) */
  dirOfInstance(instanceId: string): string | null {
    const cardId = this.cardOfInstance(instanceId);
    if (cardId === null) return null;
    return this.byCard.get(cardId)?.dir ?? null;
  }

  /** The entry file of this instance (relative to the card directory) */
  entryOfInstance(instanceId: string): string | null {
    const cardId = this.cardOfInstance(instanceId);
    if (cardId === null) return null;
    return this.byCard.get(cardId)?.manifest.entry ?? null;
  }
}

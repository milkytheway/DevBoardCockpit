/**
 * The runtime log of a card.
 *
 * ── Who writes ──
 *
 * | Source | Written by | Content |
 * |---|---|---|
 * | `card` | the card itself (`cockpit.log`) | its own words |
 * | `host` | the host (the card crashed, the handshake failed…) | what the host knows |
 * | `csp` | the host (a CSP violation was caught) | **"this card tried to reach the network"** (the promise of contract §6.1) |
 *
 * ── Why it is stored per **card id** ──
 *
 * The contract's `get_card_runtime_log(cardId)` fetches by card id.
 * But a **CSP violation carries an instance id** (`cockpit://card/<instance id>/…`) —
 * so there has to be a table "instance → card" (`bind`).
 *
 * ── What happens when it cannot be attributed ──
 *
 * **It does not land in any card.** A log attached to the wrong card is worse
 * than no log at all: it sends the agent to investigate a card that **did not
 * do anything wrong**.
 */
export type CardLogSource = 'card' | 'host' | 'csp';

export interface CardLogEntry {
  at: number;
  source: CardLogSource;
  level: 'error' | 'warn' | 'info';
  message: string;
}

/** How many entries are kept per card at most (so the log cannot fill the memory) */
export const DEFAULT_LIMIT_PER_CARD = 200;

export class CardRuntimeLog {
  private readonly entries = new Map<string, CardLogEntry[]>();
  /** instance id → card id */
  private readonly instances = new Map<string, string>();

  constructor(private readonly deps: { limitPerCard?: number; now?: () => number } = {}) {}

  /** Registers which card an instance belongs to */
  bind(instanceId: string, cardId: string): void {
    this.instances.set(instanceId, cardId);
  }

  /** Appends one entry */
  append(cardId: string, entry: Omit<CardLogEntry, 'at'> & { at?: number }): void {
    const list = this.entries.get(cardId) ?? [];
    const at = entry.at ?? this.deps.now?.() ?? Date.now();
    list.push({ at, source: entry.source, level: entry.level, message: entry.message });
    const limit = this.deps.limitPerCard ?? DEFAULT_LIMIT_PER_CARD;
    // Over the limit the **oldest** are dropped
    while (list.length > limit) list.shift();
    this.entries.set(cardId, list);
  }

  /** Reads the log of a card (in chronological order) */
  read(cardId: string): CardLogEntry[] {
    return [...(this.entries.get(cardId) ?? [])];
  }

  /**
     * Attributes a CSP violation to the card it belongs to.
     *
     * @param details what `console-message` provides: `message` + `sourceUrl`
     * @returns the card it was attributed to (**`null` when it cannot be
     *          attributed**)
     */
  attributeCspViolation(details: { message: string; sourceUrl: string }): string | null {
    const instanceId = instanceIdOf(details.sourceUrl);
    if (instanceId === null) return null;
    const cardId = this.instances.get(instanceId);
    if (cardId === undefined) return null;
    this.append(cardId, {
      source: 'csp',
      level: 'error',
      message: details.message,
    });
    return cardId;
  }
}

/** Extracts the instance id from `cockpit://card/<instance id>/…` */
function instanceIdOf(sourceUrl: string): string | null {
  const match = /^cockpit:\/\/card\/([^/]+)\//.exec(sourceUrl);
  return match?.[1] ?? null;
}

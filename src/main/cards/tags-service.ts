import type { ReasonCode, TagReading } from '../../shared/tag-reading';
import { matchTagPattern } from '../tags/vocabulary';
import { permissionCovers, type CardPermissions } from './permissions';

/**
 * The **read side** of a card: readings, lists, subscriptions, degradation.
 *
 * ── This is where the permission filter really happens ──
 *
 * Neither the page nor the bridge checks permissions (they are the untrusted
 * side). Every read and every push has to pass through `permissionCovers`
 * here.
 *
 * ── Two iron rules ──
 *
 * 1. **A tag without permission cannot be read, and it does not show whether
 *    it exists**
 *    — the returned shape is **exactly** the shape of "it was never there".
 *    Otherwise a card could use "readable / not readable" as a **probe
 *    channel** and try out every tag name on the board one by one.
 * 2. **A wildcard subscription is judged again on every push**
 *    — judging once at subscription time is not enough: the push happens
 *    **every time**.
 */
export interface TagsServiceDeps {
  /** All the current readings (from the TagStore, ADR-D22) */
  readings: () => TagReading[];
  /** Listens for changes of the readings */
  subscribe: (cb: (r: TagReading) => void) => () => void;
  now: () => number;
}

export class TagsService {
  constructor(
    private readonly perms: CardPermissions,
    private readonly deps: TagsServiceDeps,
  ) {}

  /**
     * Reads one tag.
     *
     * **No permission and no such tag look exactly the same** (information
     * hiding).
     */
  get(name: string): TagReading {
    if (!permissionCovers(this.perms, name)) return this.hidden(name);
    const found = this.deps.readings().find((r) => r.tag === name);
    if (found !== undefined) return found;
    return this.hidden(name);
  }

  /** Lists the readings the card **has permission for** */
  list(): TagReading[] {
    return this.deps.readings().filter((r) => permissionCovers(this.perms, r.tag));
  }

  /**
     * Subscribes to a tag.
     *
     * @param cb called when a reading arrives (host side)
     * @returns the unsubscribe function
     */
  subscribe(name: string, cb: (r: TagReading) => void): () => void {
    // No permission → **not a single one is pushed**, and **no subscription is kept** (that saves pointless pushes)
    if (!permissionCovers(this.perms, name)) return () => undefined;
    return this.deps.subscribe((reading) => {
      // **Judged again on every push** (iron rule 2)
      if (reading.tag !== name) return;
      if (!permissionCovers(this.perms, reading.tag)) return;
      cb(reading);
    });
  }

  /** Subscribes to a pattern (contract §7.1) */
  subscribePattern(pattern: string, cb: (r: TagReading) => void): () => void {
    if (!permissionCovers(this.perms, pattern)) return () => undefined;
    return this.deps.subscribe((reading) => {
      // **Reuses the one matcher of the vocabulary layer** (no second set of rules — a second set will eventually disagree with the first)
      if (!matchTagPattern(pattern, reading.tag)) return;
      // **The permission is judged again** (iron rule 2)
      if (!permissionCovers(this.perms, reading.tag)) return;
      cb(reading);
    });
  }

  /**
     * Degradation information: which tags cannot be read, and why.
     *
     * **Only the ones with permission are listed** — otherwise this table
     * becomes an existence probe channel.
     */
  degradation(): { tag: string; reason: ReasonCode; detail: string }[] {
    return this.deps
      .readings()
      .filter((r) => permissionCovers(this.perms, r.tag))
      .filter((r) => r.status === 'unavailable' || r.status === 'error')
      .map((r) => ({
        tag: r.tag,
        reason: r.reason ?? 'device_absent',
        detail: r.detail ?? '',
      }));
  }

  /** The readings that cannot be seen (the shape is the same as "it was never there") */
  private hidden(tag: string): TagReading {
    return {
      tag,
      value: null,
      unit: '',
      status: 'unavailable',
      reason: 'not_found',
      detail: 'this card has no read permission for this tag',
      at: this.deps.now(),
      seq: 0,
    };
  }
}

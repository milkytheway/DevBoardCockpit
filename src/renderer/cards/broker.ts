import {
  parseCardCspViolation,
  type CockpitApi,
  type CardInstanceInfo,
  type CardRequest,
  type CardResponse,
} from '../../shared/ipc-contract';

/**
 * The **card frame broker**, on the page side.
 *
 * ── It does three things ──
 *
 * | Job | How | Why |
 * |---|---|---|
 * | **Identify** | On `cockpit-hello`, use `event.source` to find out which iframe it is, **then compare `instanceId` as well** | The source alone is not enough: card A can navigate itself to the URL of card B and **borrow A's permissions** (RF-1) |
 * | **Build a channel** | Give the card a **private MessagePort** | With one shared parent window, **every card request goes through the same window**, and the cards gain a shared surface |
 * | **Forward** | Card request → main; main push → card | The permission decision belongs to main (**the untrusted side does not decide**) |
 *
 * ── It **does not decide permissions** ──
 *
 * The filtering happens in main (contract §7.1). The page only has to deliver
 * each message where it belongs.
 */

interface PortLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  start?: () => void;
}

interface FrameLike {
  contentWindow: {
    postMessage(message: unknown, targetOrigin: string, transfer?: unknown[]): void;
  };
}

interface Registered {
  instanceId: string;
  frame: FrameLike;
}

export class CardBroker {
  private readonly registered = new Map<string, Registered>();
  /** One private channel per instance */
  private readonly ports = new Map<string, PortLike>();
  private readonly offEvent: () => void;

  constructor(private readonly api: CockpitApi) {
    // A push from main → the matching card
    this.offEvent = api.onCardEvent((instanceId, payload) => {
      this.push(instanceId, payload);
    });
  }

  /** Registers the iframe of a card */
  attach(frame: FrameLike, instanceId: string): void {
    this.registered.set(instanceId, { instanceId, frame });
  }

  /** A card is gone (uninstalled / reloaded) */
  detach(instanceId: string): void {
    this.registered.delete(instanceId);
    this.ports.delete(instanceId);
  }

  /** Closing time */
  dispose(): void {
    this.offEvent();
    this.registered.clear();
    this.ports.clear();
  }

  /**
   * Handles the `message` event on the window.
   *
   * **Identification takes two steps**: `event.source` (which window) plus
   * `instanceId` (which instance).
   */
  handleMessage(event: MessageEvent): void {
    const data = event.data as { type?: string; instanceId?: string; detail?: unknown } | null;
    if (data === null || typeof data !== 'object') return;
    // A CSP violation (reported by the listener script the host injects) — not a handshake
    if (data.type === 'cockpit-csp') {
      this.onCspViolation(event, data);
      return;
    }
    if (data.type !== 'cockpit-hello') return;
    const instanceId = data.instanceId;
    if (instanceId === undefined) return;

    // ① Identify by source: **it must be the registered iframe**
    const entry = this.entryOf(event.source);
    if (entry === undefined) return;
    // ② Compare the instanceId (the RF-1 defence line)
    if (entry.instanceId !== instanceId) return;

    // ③ Open the private channel
    const channel = new MessageChannel();
    const port = channel.port1 as unknown as PortLike;
    port.onmessage = (message: { data: unknown }) => {
      void this.onCardMessage(instanceId, message.data);
    };
    port.start?.();
    this.ports.set(instanceId, port);
    entry.frame.contentWindow.postMessage({ type: 'cockpit-port' }, '*', [channel.port2]);

    // Tell main that this instance is connected
    void this.api.cardsHello(instanceId);
  }

  /**
   * A card reported a CSP violation → forward it to main.
   *
   * **Identification takes two steps** (as in the handshake):
   * ① `event.source` must be the registered iframe;
   * ② `instanceId` must match —
   *    otherwise a card could report on another card's behalf
   *    (push "it tried to reach the network" into somebody else's log).
   *
   * The detail comes from the card (an arbitrary page written by an AI) →
   * narrow it to a closed shape before it crosses the process boundary.
   */
  private onCspViolation(
    event: MessageEvent,
    data: { instanceId?: string; detail?: unknown },
  ): void {
    const instanceId = data.instanceId;
    if (instanceId === undefined) return;
    const entry = this.entryOf(event.source);
    if (entry === undefined) return;
    if (entry.instanceId !== instanceId) return;
    const detail = parseCardCspViolation(data.detail);
    if (detail === null) return;
    void this.api.cardsCsp(instanceId, detail);
  }

  /** A push from main → the private port of that card */
  push(instanceId: string, payload: unknown): void {
    const port = this.ports.get(instanceId);
    if (port === undefined) return;
    port.postMessage(payload);
  }

  /** A request from a card → main → back to that card's port */
  private async onCardMessage(instanceId: string, raw: unknown): Promise<void> {
    const port = this.ports.get(instanceId);
    if (port === undefined) return;
    const message = raw as { id?: string; method?: string; args?: unknown } | null;
    if (message === null || typeof message !== 'object') return;
    const id = message.id;
    const method = message.method;
    if (id === undefined || method === undefined) return;

    const request: CardRequest = {
      instanceId,
      id,
      method,
      args: message.args ?? {},
    };
    let response: CardResponse;
    try {
      response = await this.api.cardsRequest(request);
    } catch (err) {
      response = {
        id,
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    port.postMessage(response);
  }

  /** Which registered instance this source belongs to */
  private entryOf(source: unknown): Registered | undefined {
    for (const entry of this.registered.values()) {
      if (entry.frame.contentWindow === source) return entry;
    }
    return undefined;
  }
}

/** The shape of the card manifest (the page renders the card area from it) */
export type { CardInstanceInfo };

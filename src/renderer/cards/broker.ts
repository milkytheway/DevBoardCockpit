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
  /** 每个实例一条私有通道 */
  private readonly ports = new Map<string, PortLike>();
  private readonly offEvent: () => void;

  constructor(private readonly api: CockpitApi) {
    // main 的推送 → 对应的卡
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
    // CSP 违规（宿主注入的监听脚本报的）——不是握手
    if (data.type === 'cockpit-csp') {
      this.onCspViolation(event, data);
      return;
    }
    if (data.type !== 'cockpit-hello') return;
    const instanceId = data.instanceId;
    if (instanceId === undefined) return;

    // ① source 认人：**必须是登记过的那个 iframe**
    const entry = this.entryOf(event.source);
    if (entry === undefined) return;
    // ② instanceId 比对（RF-1 的防线）
    if (entry.instanceId !== instanceId) return;

    // ③ 建私有通道
    const channel = new MessageChannel();
    const port = channel.port1 as unknown as PortLike;
    port.onmessage = (message: { data: unknown }) => {
      void this.onCardMessage(instanceId, message.data);
    };
    port.start?.();
    this.ports.set(instanceId, port);
    entry.frame.contentWindow.postMessage({ type: 'cockpit-port' }, '*', [channel.port2]);

    // 告诉 main「这个实例连上了」
    void this.api.cardsHello(instanceId);
  }

  /**
   * 一张卡报了 CSP 违规 → 转给 main。
   *
   * **认人要认两次**（跟握手一样）：
   * ① `event.source` 必须是**登记过的那个 iframe**；
   * ② `instanceId` 要对得上——
   *    否则卡片可以**替别的卡报错**（往别人的日志里塞一条「它试图联网」）。
   *
   * 详情是**卡片给的**（AI 写的任意网页）→ 跨进程之前先收成封闭形状。
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

  /** 卡片的一个请求 → main → 回到那张卡的端口 */
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

  /** 这个 source 是登记过的哪个实例 */
  private entryOf(source: unknown): Registered | undefined {
    for (const entry of this.registered.values()) {
      if (entry.frame.contentWindow === source) return entry;
    }
    return undefined;
  }
}

/** The shape of the card manifest (the page renders the card area from it) */
export type { CardInstanceInfo };

import {
  parseCardCspViolation,
  type CockpitApi,
  type CardInstanceInfo,
  type CardRequest,
  type CardResponse,
} from '../../shared/ipc-contract';

/**
 * 页面侧的**卡片帧经纪人**。
 *
 * ── 它做三件事 ──
 *
 * | 事 | 怎么做 | 为什么 |
 * |---|---|---|
 * | **认人** | 收到 `cockpit-hello` 时用 `event.source` 认出是哪个 iframe，**再比一次 instanceId** | 只比 source 不够：卡片 A 把自己导航到卡片 B 的 URL，就会**借到 A 的权限**（RF-1） |
 * | **建通道** | 给这张卡一条**私有的 MessagePort** | 共用父窗口的话，**每张卡的请求都经过同一个窗口**，卡与卡之间就有了公共面 |
 * | **转发** | 卡片的请求 → main；main 的推送 → 卡 | 权限判定在 main（**不可信的一侧不做判断**） |
 *
 * ── 它**不判权限** ──
 *
 * 权限过滤在 main 侧（契约 §7.1）。页面只负责「把消息送到该去的地方」。
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

  /** 登记一张卡的 iframe */
  attach(frame: FrameLike, instanceId: string): void {
    this.registered.set(instanceId, { instanceId, frame });
  }

  /** 一张卡没了（卸载 / 重载） */
  detach(instanceId: string): void {
    this.registered.delete(instanceId);
    this.ports.delete(instanceId);
  }

  /** 收摊 */
  dispose(): void {
    this.offEvent();
    this.registered.clear();
    this.ports.clear();
  }

  /**
   * 处理窗口上的 `message` 事件。
   *
   * **认人要认两次**：`event.source`（哪个窗口）+ `instanceId`（哪个实例）。
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

  /** main 的推送 → 那张卡的私有端口 */
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

/** 卡片清单的形状（页面用它渲染卡片区） */
export type { CardInstanceInfo };

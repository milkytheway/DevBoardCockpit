import { describe, it, expect, vi } from 'vitest';
import { CardBroker } from '../../src/renderer/cards/broker';
import type { CockpitApi } from '../../src/shared/ipc-contract';

/**
 * 页面侧的卡片帧经纪人。
 *
 * ── 它做三件事 ──
 *
 * 1. **认人**：收到 `cockpit-hello` 时，用 `event.source` 认出是哪个 iframe；
 *    **再比一次 instanceId**（RF-1 的防线）——
 *    不比的话，卡片 A 把自己导航到卡片 B 的 URL，就会**借到 A 的权限**。
 * 2. **建通道**：给这张卡一条**私有的 MessagePort**（不是共用父窗口的广播）。
 * 3. **转发**：卡片的请求 → main；main 的推送 → 卡。
 *
 * ── 为什么请求不直接走 `parent.postMessage` ──
 *
 * 共用父窗口的话，**每张卡的请求都经过同一个窗口**——
 * 卡片之间就能互相看见（只要知道对方的 instanceId）。
 * 私有端口 = 每张卡一条线，**卡与卡之间没有公共面**。
 */
interface FakeWindow {
  postMessage: (message: unknown, targetOrigin: string, transfer?: unknown[]) => void;
}

interface FakeFrame {
  contentWindow: FakeWindow;
}

function makeFrame(): FakeFrame & { posted: { message: unknown; transfer: unknown[] }[] } {
  const posted: { message: unknown; transfer: unknown[] }[] = [];
  return {
    posted,
    contentWindow: {
      postMessage: (message, _targetOrigin, transfer) => {
        posted.push({ message, transfer: transfer ?? [] });
      },
    },
  };
}

function installApi(over: Partial<CockpitApi> = {}): CockpitApi {
  const api = {
    cardsList: async () => [],
    cardsHello: async () => undefined,
    cardsRequest: async () => ({ id: 'r1', ok: true, value: null }),
    onCardEvent: () => () => undefined,
    ...over,
  } as unknown as CockpitApi;
  (window as unknown as { cockpit: unknown }).cockpit = api;
  return api;
}

describe('卡片帧经纪人 · 认人', () => {
  it('收到 hello：建通道并把端口转给那张卡', () => {
    const frame = makeFrame();
    const broker = new CardBroker(installApi());
    broker.attach(frame as unknown as HTMLIFrameElement, 'inst-1');

    broker.handleMessage({
      source: frame.contentWindow,
      data: { type: 'cockpit-hello', instanceId: 'inst-1' },
    } as unknown as MessageEvent);

    expect(frame.posted).toHaveLength(1);
    expect((frame.posted[0]?.message as { type: string }).type).toBe('cockpit-port');
    expect(frame.posted[0]?.transfer.length).toBe(1);
  });

  it('**instanceId 对不上 → 丢弃**（卡片 A 导航到卡片 B 的 URL，RF-1）', () => {
    const frame = makeFrame();
    const broker = new CardBroker(installApi());
    broker.attach(frame as unknown as HTMLIFrameElement, 'inst-1');

    broker.handleMessage({
      source: frame.contentWindow,
      data: { type: 'cockpit-hello', instanceId: 'inst-OTHER' },
    } as unknown as MessageEvent);

    expect(frame.posted).toHaveLength(0);
  });

  it('不是登记过的 frame → 丢弃', () => {
    const frame = makeFrame();
    const other = makeFrame();
    const broker = new CardBroker(installApi());
    broker.attach(frame as unknown as HTMLIFrameElement, 'inst-1');

    broker.handleMessage({
      source: other.contentWindow,
      data: { type: 'cockpit-hello', instanceId: 'inst-1' },
    } as unknown as MessageEvent);

    expect(frame.posted).toHaveLength(0);
    expect(other.posted).toHaveLength(0);
  });

  it('不是 hello 的消息 → 不管', () => {
    const frame = makeFrame();
    const broker = new CardBroker(installApi());
    broker.attach(frame as unknown as HTMLIFrameElement, 'inst-1');

    broker.handleMessage({
      source: frame.contentWindow,
      data: { type: 'something-else' },
    } as unknown as MessageEvent);

    expect(frame.posted).toHaveLength(0);
  });
});

describe('卡片帧经纪人 · 转发', () => {
  it('卡片的请求 → main → 原样回到那张卡的端口', async () => {
    const frame = makeFrame();
    const calls: { method: string; args: unknown }[] = [];
    const api = installApi({
      cardsRequest: async (req) => {
        calls.push({ method: req.method, args: req.args });
        return { id: req.id, ok: true, value: 42 };
      },
    });
    const broker = new CardBroker(api);
    broker.attach(frame as unknown as HTMLIFrameElement, 'inst-1');

    // 先握手
    broker.handleMessage({
      source: frame.contentWindow,
      data: { type: 'cockpit-hello', instanceId: 'inst-1' },
    } as unknown as MessageEvent);

    // 卡那边拿到端口，向它发一个请求
    const cardPort = frame.posted[0]?.transfer[0] as MessagePort;
    expect(cardPort).toBeTruthy();
    const answers: unknown[] = [];
    cardPort.onmessage = (event: { data: unknown }) => {
      answers.push(event.data);
    };
    cardPort.postMessage({ id: 'r9', method: 'tags.get', args: { name: 'cpu.usage' } });

    // 等一拍（请求是异步的）
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(1);
    expect(calls[0]?.method).toBe('tags.get');
    expect(answers.length).toBe(1);
    expect((answers[0] as { value: number }).value).toBe(42);
  });

  it('main 的推送 → 走那条私有端口', () => {
    const frame = makeFrame();
    let push: ((instanceId: string, payload: unknown) => void) | undefined;
    installApi({
      onCardEvent: (cb) => {
        push = cb;
        return () => undefined;
      },
    });
    const broker = new CardBroker((window as unknown as { cockpit: CockpitApi }).cockpit);
    broker.attach(frame as unknown as HTMLIFrameElement, 'inst-1');
    broker.handleMessage({
      source: frame.contentWindow,
      data: { type: 'cockpit-hello', instanceId: 'inst-1' },
    } as unknown as MessageEvent);

    expect(push).toBeTruthy();
    // 推送不该抛
    expect(() => push?.('inst-1', { type: 'push' })).not.toThrow();
  });

  it('还没握手就推送 → 不炸', () => {
    const broker = new CardBroker(installApi());
    expect(() => broker.push('inst-1', { type: 'push' })).not.toThrow();
  });
});

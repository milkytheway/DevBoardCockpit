import { describe, it, expect } from 'vitest';
import { CardBroker } from '../../src/renderer/cards/broker';
import type { CockpitApi } from '../../src/shared/ipc-contract';

/**
 * The card frame broker on the page side.
 *
 * ── What it does ──
 *
 * 1. **Recognises the sender**: on `cockpit-hello` it uses `event.source` to
 *    work out which iframe the message came from, and compares the instance
 *    id as well — that comparison is the defence of RF-1. Without it, card A
 *    could navigate itself to the URL of card B and borrow A's permissions.
 * 2. **Builds the channel**: the card gets a private MessagePort, not a
 *    broadcast on the shared parent window.
 * 3. **Forwards**: a request from the card goes to main; a push from main
 *    goes to the card.
 *
 * ── Why the requests do not go through `parent.postMessage` ──
 *
 * On a shared parent window every request of every card passes through the
 * same window, so two cards can see each other as soon as they know the
 * other's instance id. A private port gives each card its own line, and
 * there is no common surface between two cards.
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

describe('The card frame broker · recognising the sender', () => {
  it('on hello it builds the channel and hands the port to that card', () => {
    const frame = makeFrame();
    const broker = new CardBroker(installApi());
    broker.attach({ contentWindow: frame.contentWindow }, 'inst-1');

    broker.handleMessage({
      source: frame.contentWindow,
      data: { type: 'cockpit-hello', instanceId: 'inst-1' },
    } as unknown as MessageEvent);

    expect(frame.posted).toHaveLength(1);
    expect((frame.posted[0]?.message as { type: string }).type).toBe('cockpit-port');
    expect(frame.posted[0]?.transfer.length).toBe(1);
  });

  it('a mismatched instance id is discarded (card A navigated to the URL of card B — RF-1)', () => {
    const frame = makeFrame();
    const broker = new CardBroker(installApi());
    broker.attach({ contentWindow: frame.contentWindow }, 'inst-1');

    broker.handleMessage({
      source: frame.contentWindow,
      data: { type: 'cockpit-hello', instanceId: 'inst-OTHER' },
    } as unknown as MessageEvent);

    expect(frame.posted).toHaveLength(0);
  });

  it('a frame that was never registered is discarded', () => {
    const frame = makeFrame();
    const other = makeFrame();
    const broker = new CardBroker(installApi());
    broker.attach({ contentWindow: frame.contentWindow }, 'inst-1');

    broker.handleMessage({
      source: other.contentWindow,
      data: { type: 'cockpit-hello', instanceId: 'inst-1' },
    } as unknown as MessageEvent);

    expect(frame.posted).toHaveLength(0);
    expect(other.posted).toHaveLength(0);
  });

  it('a message that is not a hello is ignored', () => {
    const frame = makeFrame();
    const broker = new CardBroker(installApi());
    broker.attach({ contentWindow: frame.contentWindow }, 'inst-1');

    broker.handleMessage({
      source: frame.contentWindow,
      data: { type: 'something-else' },
    } as unknown as MessageEvent);

    expect(frame.posted).toHaveLength(0);
  });
});

describe('The card frame broker · forwarding', () => {
  it('a request from the card goes to main and comes back unchanged on the port of that card', async () => {
    const frame = makeFrame();
    const calls: { method: string; args: unknown }[] = [];
    const api = installApi({
      cardsRequest: async (req) => {
        calls.push({ method: req.method, args: req.args });
        return { id: req.id, ok: true, value: 42 };
      },
    });
    const broker = new CardBroker(api);
    broker.attach({ contentWindow: frame.contentWindow }, 'inst-1');

    // The handshake comes first
    broker.handleMessage({
      source: frame.contentWindow,
      data: { type: 'cockpit-hello', instanceId: 'inst-1' },
    } as unknown as MessageEvent);

    // The card holds the port now and sends a request through it
    const cardPort = frame.posted[0]?.transfer[0] as MessagePort;
    expect(cardPort).toBeTruthy();
    const answers: unknown[] = [];
    cardPort.onmessage = (event: { data: unknown }) => {
      answers.push(event.data);
    };
    cardPort.postMessage({ id: 'r9', method: 'tags.get', args: { name: 'cpu.usage' } });

    // Give the asynchronous request a tick
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(1);
    expect(calls[0]?.method).toBe('tags.get');
    expect(answers.length).toBe(1);
    expect((answers[0] as { value: number }).value).toBe(42);
  });

  it('a push from main goes through that private port', () => {
    const frame = makeFrame();
    let push: ((instanceId: string, payload: unknown) => void) | undefined;
    installApi({
      onCardEvent: (cb) => {
        push = cb;
        return () => undefined;
      },
    });
    const broker = new CardBroker((window as unknown as { cockpit: CockpitApi }).cockpit);
    broker.attach({ contentWindow: frame.contentWindow }, 'inst-1');
    broker.handleMessage({
      source: frame.contentWindow,
      data: { type: 'cockpit-hello', instanceId: 'inst-1' },
    } as unknown as MessageEvent);

    expect(push).toBeTruthy();
    // The push must not throw
    expect(() => push?.('inst-1', { type: 'push' })).not.toThrow();
  });

  it('a push before the handshake does not blow up', () => {
    const broker = new CardBroker(installApi());
    expect(() => broker.push('inst-1', { type: 'push' })).not.toThrow();
  });
});

describe('The card frame broker · CSP violations', () => {
  it('on cockpit-csp the violation is passed to main, with the instance id and the details', () => {
    const frame = makeFrame();
    const seen: { instanceId: string; detail: unknown }[] = [];
    const broker = new CardBroker(
      installApi({
        cardsCsp: async (instanceId: string, detail: unknown) => {
          seen.push({ instanceId, detail });
          return undefined;
        },
      }),
    );
    broker.attach({ contentWindow: frame.contentWindow }, 'inst-1');

    const detail = {
      blockedURI: 'https://evil.example/',
      effectiveDirective: 'connect-src',
      violatedDirective: 'connect-src',
      sourceFile: '',
      lineNumber: 12,
      sample: '',
    };
    broker.handleMessage({
      source: frame.contentWindow,
      data: { type: 'cockpit-csp', instanceId: 'inst-1', detail },
    } as unknown as MessageEvent);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.instanceId).toBe('inst-1');
    expect((seen[0]?.detail as { blockedURI: string }).blockedURI).toBe('https://evil.example/');
  });

  it('a mismatched instance id is discarded (a card may not report a violation for another card)', () => {
    const frame = makeFrame();
    const seen: unknown[] = [];
    const broker = new CardBroker(
      installApi({
        cardsCsp: async (instanceId: string) => {
          seen.push(instanceId);
          return undefined;
        },
      }),
    );
    broker.attach({ contentWindow: frame.contentWindow }, 'inst-1');

    broker.handleMessage({
      source: frame.contentWindow,
      data: {
        type: 'cockpit-csp',
        instanceId: 'inst-OTHER',
        detail: { blockedURI: 'https://evil.example/' },
      },
    } as unknown as MessageEvent);

    expect(seen).toHaveLength(0);
  });
});

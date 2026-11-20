import { describe, it, expect } from 'vitest';
import { cardApis, apiByName } from '../../../src/main/cards/api-registry';
import { bridgeScriptFor } from '../../../src/main/cards/bridge-script';

/**
 * The **single source of truth** of the card API.
 *
 * Why it has to be one copy:
 *
 * If the host implementation and the bridge script injected into the card were
 * written separately, they would drift apart — the card calls
 * `cockpit.tags.get` while the host only has `cockpit.tagsGet`, the symptom is
 * "the card says the method does not exist", and **nobody can tell which side
 * is wrong**.
 *
 * Therefore **the registry is the only list** and the bridge script is
 * **generated** from it. Adding a method touches the registry in one place.
 */
describe('the card API registry', () => {
  it('it has the methods that M5 needs', () => {
    const names = [...apiByName().keys()].sort();
    expect(names).toContain('capabilities');
    expect(names).toContain('tags.get');
    expect(names).toContain('tags.subscribe');
    expect(names).toContain('tags.subscribePattern');
    expect(names).toContain('tags.list');
    expect(names).toContain('degradation');
    expect(names).toContain('storage.get');
    expect(names).toContain('log');
  });

  it('**`notify` is not in the list of implemented methods** (the host channel is not connected yet; listing it would mean the card believes the notification went out)', () => {
    const names = [...apiByName().keys()];
    expect(names).not.toContain('notify');
  });

  it('**the write side exists since M6** (actions.invoke is in the list)', () => {
    expect(apiByName().has('actions.invoke')).toBe(true);
    // The write permission is judged by **action id** (contract §2.3: the read
// permission uses a pattern, the write permission does not)
    expect(apiByName().get('actions.invoke')?.permission).toBe('write');
    expect(apiByName().get('actions.invoke')?.scopeArg).toBe('id');
  });

  it('**the workflow side exists since plan 7** (the three entries of contract §7.7)', () => {
    const byName = apiByName();
    expect(byName.has('workflows.list')).toBe(true);
    expect(byName.has('workflows.run')).toBe(true);
    expect(byName.has('workflows.status')).toBe(true);
    // **The write permission of a workflow is a dimension of its own** (**it may
// not be mixed into permissions.write** — contract §2.3)
    expect(byName.get('workflows.run')?.permission).toBe('workflow');
    // **The permission looks at the workflow id**
    expect(byName.get('workflows.run')?.scopeArg).toBe('id');
  });

  it('the permission of a read method is read, the one of storage and logging is none', () => {
    const byName = apiByName();
    expect(byName.get('tags.get')?.permission).toBe('read');
    expect(byName.get('tags.list')?.permission).toBe('read');
    expect(byName.get('storage.set')?.permission).toBe('none');
    expect(byName.get('log')?.permission).toBe('none');
    expect(byName.get('capabilities')?.permission).toBe('none');
  });

  it('a read method states which parameter the permission looks at', () => {
    const byName = apiByName();
    expect(byName.get('tags.get')?.scopeArg).toBe('name');
    expect(byName.get('tags.subscribePattern')?.scopeArg).toBe('pattern');
  });

  it('every method name is valid (dotted, not empty)', () => {
    for (const api of cardApis()) {
      expect(api.name).toMatch(/^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)*$/);
    }
  });
});

describe('the generation of the bridge script', () => {
  const script = bridgeScriptFor(cardApis(), 'inst-42');

  it('it defines window.cockpit', () => {
    expect(script).toContain('window.cockpit');
  });

  it('**every registered method is in it** (the single source of truth delivered)', () => {
    for (const api of cardApis()) {
      const [ns, fn] = api.name.split('.');
      expect(script).toContain(ns ?? '');
      expect(script).toContain(fn ?? '');
    }
  });

  it('**no** require / import (it runs in a sandboxed iframe, there is no Node)', () => {
    expect(script).not.toMatch(/\brequire\s*\(/);
    expect(script).not.toMatch(/\bimport\s/);
  });

  it('the handshake carries the instanceId (the host identifies the caller by it, the defence of RF-1)', () => {
    expect(script).toContain('inst-42');
    expect(script).toContain('cockpit-hello');
  });

  it('an unknown method is answered with unknown_method, **it is not sent on**', () => {
    expect(script).toContain('unknown_method');
  });

  it('it is a self-contained IIFE (it leaks nothing into the global scope)', () => {
    expect(script).toContain('(() => {');
    expect(script).toContain('})();');
  });
});

/**
 * The bridge script **really runs**.
 *
 * Why it is not enough to test "the script text contains this sentence":
 *
 * An assertion on the script text only proves that the code was generated, not
 * that **the card receives what it needs**.
 *
 * This was once genuinely wrong:
 *
 * The usage written down in contract `spec/03` §7.7 is:
 * ```js
 * const caps = await cockpit.capabilities();
 * // { apiVersion: 'devboard/v1', methods: […], connection: {…}, tags: […] }
 * ```
 * while the bridge handed the card **the whole transport envelope**
 * (`{ id, ok, value }`), so the card received
 * `{ id: 'r1', ok: true, value: {…} }`, `caps.methods` was **undefined**, and
 * the card believed the host supported no method at all.
 *
 * Therefore the bridge has to **unwrap**: `value` on success,
 * `{ ok:false, reason }` on failure.
 */
interface FakePort {
  postMessage: (m: unknown) => void;
  onmessage: ((m: { data: unknown }) => void) | null;
}

function runBridge(
  instanceId: string,
  opts: { deliverPort?: boolean } = {},
): {
  cockpit: Record<string, unknown>;
  port: FakePort;
  hello: unknown[];
  sent: unknown[];
  /** Calls it when the port arrives later */
  deliverPort: () => void;
} {
  const script = bridgeScriptFor(cardApis(), instanceId);
  const listeners: ((e: unknown) => void)[] = [];
  const sent: unknown[] = [];
  const hello: unknown[] = [];
  const fakeWindow: Record<string, unknown> = {
    addEventListener: (type: string, cb: (e: unknown) => void) => {
      if (type === 'message') listeners.push(cb);
    },
  };
  const fakeParent = { postMessage: (m: unknown) => void hello.push(m) };
  // `window` and `parent` are passed in as **parameters** to shadow the globals
  new Function('window', 'parent', script)(fakeWindow, fakeParent);
  const port: FakePort = { postMessage: (m) => sent.push(m), onmessage: null };
  // The host hands the port to the card
  const deliver = (): void => {
    listeners[0]?.({ data: { type: 'cockpit-port' }, ports: [port] });
  };
  if (opts.deliverPort !== false) deliver();
  return {
    cockpit: fakeWindow['cockpit'] as never,
    port,
    hello,
    sent,
    deliverPort: deliver,
  };
}

/** Takes the request id from a sent message (the counter of the bridge gives the subscription id one step earlier) */
function idOf(sent: unknown[]): string {
  const first = sent[0] as { id?: string } | undefined;
  if (first?.id === undefined) throw new Error('the bridge did not send a request');
  return first.id;
}

describe('the bridge script · what the card really sees', () => {
  it('the handshake reports the instanceId to the host (the credential of RF-1)', () => {
    const { hello } = runBridge('inst-42');
    expect(hello).toEqual([{ type: 'cockpit-hello', instanceId: 'inst-42' }]);
  });

  it('**on success → the card receives the "value", not the transport envelope**', async () => {
    const { cockpit, port, sent } = runBridge('inst-42');
    const pending = (cockpit['capabilities'] as () => Promise<unknown>)();
    const caps = { apiVersion: 'devboard/v1', methods: ['tags.get'], connection: null, tags: [] };
    port.onmessage?.({ data: { id: idOf(sent), ok: true, value: caps } });
    await expect(pending).resolves.toEqual(caps);
  });

  it('**on failure → the card receives { ok:false, reason }** (contract §7.7: no exception is thrown)', async () => {
    const { cockpit, port, sent } = runBridge('inst-42');
    const tags = cockpit['tags'] as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const pending = tags['get']?.('cpu.usage');
    port.onmessage?.({ data: { id: idOf(sent), ok: false, reason: 'unknown_method' } });
    await expect(pending).resolves.toEqual({ ok: false, reason: 'unknown_method' });
  });

  it('the subscription is refused → the card sees the reason (**not** a silent acceptance)', async () => {
    const { cockpit, port, sent } = runBridge('inst-42');
    const tags = cockpit['tags'] as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const pending = tags['subscribe']?.('cpu.usage', () => undefined);
    port.onmessage?.({ data: { id: idOf(sent), ok: false, reason: 'too_many_subscriptions' } });
    await expect(pending).resolves.toEqual({ ok: false, reason: 'too_many_subscriptions' });
  });
});

describe('the bridge script · the top-level methods are functions', () => {
  it('**`cockpit.capabilities()` can be called** (the usage of contract §7.7, not `cockpit.capabilities.capabilities()`)', async () => {
    const { cockpit, port, sent } = runBridge('inst-42');
    const pending = (cockpit['capabilities'] as () => Promise<unknown>)();
    const caps = { apiVersion: 'devboard/v1', methods: ['tags.get'], connection: null, tags: [] };
    port.onmessage?.({ data: { id: idOf(sent), ok: true, value: caps } });
    await expect(pending).resolves.toEqual(caps);
  });

  it('**`cockpit.log(level, message)` can be called**', async () => {
    const { cockpit, port, sent } = runBridge('inst-42');
    const pending = (cockpit['log'] as (...a: unknown[]) => Promise<unknown>)('error', 'hi');
    port.onmessage?.({ data: { id: idOf(sent), ok: true, value: { ok: true } } });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('**`cockpit.degradation()` can be called**', async () => {
    const { cockpit, port, sent } = runBridge('inst-42');
    const pending = (cockpit['degradation'] as () => Promise<unknown>)();
    port.onmessage?.({ data: { id: idOf(sent), ok: true, value: [] } });
    await expect(pending).resolves.toEqual([]);
  });

  it('**an unknown name is still answered with unknown_method** (not a TypeError)', async () => {
    const { cockpit } = runBridge('inst-42');
    const pending = (cockpit['nope'] as () => Promise<unknown>)();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'unknown_method' });
  });

  it('**an unknown method inside a namespace is unknown_method as well** (the top level and the namespace are two layers of Proxy)', async () => {
    const { cockpit } = runBridge('inst-42');
    const tags = cockpit['tags'] as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const pending = tags['nope']?.();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'unknown_method' });
  });

  it('**the methods of a namespace are unaffected** (`cockpit.tags.get`)', async () => {
    const { cockpit, port, sent } = runBridge('inst-42');
    const tags = cockpit['tags'] as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const pending = tags['get']?.('cpu.usage');
    port.onmessage?.({ data: { id: idOf(sent), ok: true, value: { tag: 'cpu.usage' } } });
    await expect(pending).resolves.toEqual({ tag: 'cpu.usage' });
  });
});

describe('the bridge · while the port has not arrived yet', () => {
  /**
   * What this criterion defends against:
   *
   * The port arrives **after the handshake** (page → iframe postMessage), and
   * it is normal that the script of the card **runs first** and the port
   * **arrives later** (especially for a card **installed by a hot reload**:
   * the iframe has just been created, the script runs at once, and the port is
   * still on its way).
   *
   * → The old behaviour answered `not_connected` as soon as the port was
   *   missing, and the card **silently did nothing** (the mistake an
   *   AI-written card makes most often: calling the API while loading).
   * → The new behaviour **waits for it** (up to 10 seconds) and only then
   *   really sends it.
   *
   * → This was a real bug caught by an end-to-end test.
   */
  it('a call has to **wait for the port** instead of answering not_connected at once', async () => {
    const bridge = runBridge('inst-late', { deliverPort: false });
    const cockpit = bridge.cockpit as {
      tags: { get(name: string): Promise<unknown> };
    };

    const pending = cockpit.tags.get('cpu.usage');
    // **it has not been sent yet** (the port has not arrived, there is nobody to
// receive it)
    expect(bridge.sent).toHaveLength(0);

    // The port arrived → **the waiting call really was sent**
    bridge.deliverPort();
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.sent.length).toBe(1);

    // It answers it, and the call really resolves
    const first = bridge.sent[0] as { id: string };
    bridge.port.onmessage?.({ data: { id: first.id, ok: true, value: 42 } });
    await expect(pending).resolves.toBe(42);
  });
});
